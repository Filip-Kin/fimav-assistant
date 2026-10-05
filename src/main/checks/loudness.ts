import log from 'electron-log';
import { enqueueCut, ffmpegPath, run } from '../cutMatch';
import { updateMatch } from '../recordings/matchStore';
import { MatchRecord } from '../../models/MatchRecord';

// Loudness of a finished match video, the same Bus A mix the stream carries
// (FIM records and streams Bus A). ffmpeg's ebur128 filter prints a summary
// with the integrated loudness (I: ... LUFS) and, with peak=true, the true
// peak (Peak: ... dBFS).
export async function measureLoudness(
    file: string
): Promise<{ lufs: number; truePeak: number | null } | null> {
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
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
    if (!i) return null;
    const p = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
    const num = (s: string) => (s === '-inf' ? -Infinity : parseFloat(s));
    return { lufs: num(i[1]), truePeak: p ? num(p[1]) : null };
}

// Measure a match's final video and store it on its record. Queued with the
// cuts so encodes and measurements never run side by side.
export function queueLoudness(
    folder: string,
    recordId: string,
    file: string,
    onRecord: (_rec: MatchRecord) => void
) {
    enqueueCut(async () => {
        try {
            const loudness = await measureLoudness(file);
            if (!loudness) return;
            const rec = updateMatch(folder, recordId, { loudness });
            if (rec) onRecord(rec);
        } catch (e) {
            log.warn('Loudness measurement failed', e);
        }
    });
}
