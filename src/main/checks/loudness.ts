import log from 'electron-log';
import { enqueueCut, ffmpegPath, run } from '../cutMatch';
import { updateMatch } from '../recordings/matchStore';
import { MatchRecord, MatchTalkLoudness } from '../../models/MatchRecord';
import { inSpans, MIN_TALK_SECONDS, Span, talkLog } from './talking';

// Loudness of a finished match video, the same Bus A mix the stream carries
// (FIM records and streams Bus A). ffmpeg's ebur128 filter prints, every
// 100 ms, the momentary loudness (M:) of the 400 ms ending there (BS.1770
// K-weighted), then a summary with the integrated loudness (I: ... LUFS) and,
// with peak=true, the true peak (Peak: ... dBFS).
//
// The integrated loudness of the whole match counts the quiet stretches
// between announcements. The verdict instead uses only the 400 ms blocks in
// which a mic was live (talking.ts), gated the BS.1770 way: blocks under
// -70 LUFS dropped, then blocks more than 10 LU under the rest. That is the
// loudness of the stream while someone talks, which is what YouTube's
// -14 LUFS reference is about.

export interface LoudnessBlock {
    // End of the 400 ms block, seconds into the file.
    t: number;
    // Momentary loudness of the block, LUFS (-Infinity for silence).
    m: number;
}

// A stretch of the video and the wall-clock time its first frame was
// recorded, in file order: one for a whole recording, two for a cut match
// (match + results), one per piece for an FTC match.
export interface WallSegment {
    wallStart: number; // epoch ms
    seconds: number;
}

// ebur128 gives a 400 ms block every 100 ms.
const BLOCKS_PER_SECOND = 10;

const ABS_GATE = -70;
const REL_GATE = 10;

const num = (s: string) => (s === '-inf' ? -Infinity : parseFloat(s));

// The ebur128 output of one ffmpeg run: per-block momentary loudness and
// the summary.
export function parseEbur128(stderr: string): {
    lufs: number;
    truePeak: number | null;
    blocks: LoudnessBlock[];
} | null {
    const at = stderr.lastIndexOf('Summary:');
    const summary = at >= 0 ? stderr.slice(at) : '';
    const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
    if (!i) return null;
    const p = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
    const blocks: LoudnessBlock[] = [];
    const frame = /\bt:\s*([\d.]+)\s.*?\bM:\s*(-?[\d.]+|-inf)/g;
    const head = at >= 0 ? stderr.slice(0, at) : stderr;
    let m = frame.exec(head);
    while (m) {
        blocks.push({ t: parseFloat(m[1]), m: num(m[2]) });
        m = frame.exec(head);
    }
    return { lufs: num(i[1]), truePeak: p ? num(p[1]) : null, blocks };
}

// BS.1770 gated loudness of a set of 400 ms block loudnesses, or null when
// every block is under the absolute gate.
export function gatedLoudness(ms: number[]): number | null {
    const mean = (xs: number[]) =>
        10 * Math.log10(xs.reduce((s, x) => s + 10 ** (x / 10), 0) / xs.length);
    const loud = ms.filter((x) => x > ABS_GATE);
    if (!loud.length) return null;
    const relative = mean(loud) - REL_GATE;
    return mean(loud.filter((x) => x > relative));
}

// Wall-clock time (epoch ms) of a point in the video, or null past its end.
export function wallTime(segments: WallSegment[], sec: number): number | null {
    let start = 0;
    for (let k = 0; k < segments.length; k += 1) {
        const s = segments[k];
        if (sec < start + s.seconds) return s.wallStart + (sec - start) * 1000;
        start += s.seconds;
    }
    return null;
}

// The video's loudness while someone talked on the mics.
export function talkLoudness(
    blocks: LoudnessBlock[],
    segments: WallSegment[],
    spans: { heard: Span[]; talk: Span[] }
): MatchTalkLoudness {
    let heard = false;
    const talking: number[] = [];
    blocks.forEach((b) => {
        // The first blocks are under 400 ms long (ffmpeg pads them).
        if (b.t < 0.399) return;
        const wall = wallTime(segments, b.t - 0.2);
        if (wall === null) return;
        if (inSpans(spans.heard, wall)) heard = true;
        if (inSpans(spans.talk, wall)) talking.push(b.m);
    });
    return {
        heard,
        seconds: talking.length / BLOCKS_PER_SECOND,
        lufs:
            talking.length >= MIN_TALK_SECONDS * BLOCKS_PER_SECOND
                ? gatedLoudness(talking)
                : null,
    };
}

export async function measureLoudness(file: string) {
    const { stderr } = await run(ffmpegPath(), [
        '-hide_banner',
        '-nostats',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-af',
        'ebur128=peak=true',
        '-f',
        'null',
        '-',
    ]);
    return parseEbur128(stderr);
}

// Measure a match's final video and store it on its record. Queued with the
// cuts so encodes and measurements never run side by side. `segments` maps
// the video back to wall-clock time, to line it up with the mic levels.
export function queueLoudness(
    folder: string,
    recordId: string,
    file: string,
    segments: WallSegment[],
    onRecord: (_rec: MatchRecord) => void
) {
    enqueueCut(async () => {
        try {
            const measured = await measureLoudness(file);
            if (!measured) return;
            const { lufs, truePeak, blocks } = measured;
            const talk = talkLoudness(blocks, segments, talkLog);
            const rec = updateMatch(folder, recordId, {
                loudness: { lufs, truePeak, talk },
            });
            if (rec) onRecord(rec);
        } catch (e) {
            log.warn('Loudness measurement failed', e);
        }
    });
}
