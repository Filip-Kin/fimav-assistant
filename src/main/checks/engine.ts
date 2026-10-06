import { EventEmitter } from 'events';
import log from 'electron-log';
import VmixService from '../../services/VmixService';
import AutoAV from '../addons/autoav';
import LiveCaptions from '../addons/live-captions';
import HWPing from '../addons/hw-ping';
import getVmixBandwidth from '../vmixBandwidth';
import { listMatches } from '../recordings/matchStore';
import { getStore } from '../store';
import { levelToDb, queryXair, XairMeters } from './xair';
import { CheckResult, CheckState } from '../../models/Checks';

// Stream and audio checks for a live event. Every check reads state the cart
// already has (the vMix API, vMix's stream logs, the X-Air over OSC, FMS or
// FTC Live match state, the match manifest) and nothing records or decodes
// audio or video live. Light by design:
//  - vMix API: every 2 s during a match, every 5 s otherwise
//  - stream logs: every 5 s (ffmpeg's speed=, not bitrate: the stream is VBR)
//  - X-Air settings: ~30 tiny UDP queries every 10 s (network, not USB)
//  - X-Air meters: subscribed only while a qual/playoff match is in play
//  - loudness: one audio-only ffmpeg pass per finished match (loudness.ts)
// A check that is failing raises a banner and a Windows notification once;
// "Ignore 6 h" silences that one check (kept in the store across restarts).

export type { CheckResult, CheckState } from '../../models/Checks';

const IGNORE_MS = 6 * 60 * 60 * 1000;

// Loudness range for the stream (YouTube normalises to about -14 LUFS and
// wants true peak at or under -1 dBTP; outside this range is a warning).
const LUFS_LOW = -18;
const LUFS_HIGH = -11;
const TRUE_PEAK_MAX = -1;

// A send or fader at or under this is treated as off.
const OFF_DB = -40;

// Mics vs match sounds on the stream bus: only a big gap is reported.
const BALANCE_DB = 15;

type Def = Pick<CheckResult, 'id' | 'group' | 'label'>;

const DEFS: Def[] = [
    { id: 'stream-match', group: 'Stream', label: 'Stream during match' },
    { id: 'stream-health', group: 'Stream', label: 'Stream health' },
    {
        id: 'recording-match',
        group: 'Recording',
        label: 'Recording during match',
    },
    { id: 'stream-audio', group: 'Audio', label: 'Stream audio (Bus A)' },
    { id: 'stream-loudness', group: 'Audio', label: 'Stream loudness' },
    { id: 'dj-stream', group: 'Audio', label: 'DJ on stream bus' },
    { id: 'match-sounds', group: 'Audio', label: 'Match sounds' },
    { id: 'match-buzzer', group: 'Audio', label: 'Match start sound' },
    { id: 'mic-balance', group: 'Audio', label: 'Mics vs match sounds' },
    { id: 'captions', group: 'Captions', label: 'Captions overlay' },
];

const truthy = (v: unknown) =>
    String(
        typeof v === 'object' && v ? (v as any)['#text'] : v
    ).toLowerCase() === 'true';

const list = <T>(v: T | T[] | undefined): T[] => {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
};

// Linear vMix meter (0..1) to dB.
const meterDb = (v: unknown) => {
    const n = Number(v);
    return n > 0 ? 20 * Math.log10(n) : -Infinity;
};

interface MixerSource {
    name: string;
    // OSC prefix: /ch/NN or /rtn/aux
    path: string;
    // Meter index in /meters/1 (left side for stereo)
    meter: number;
    on?: boolean;
    faderDb?: number;
    lr?: boolean;
    streamSendDb?: number;
}

interface MixerState {
    at: number;
    reachable: boolean;
    streamBus: number;
    streamBusName: string;
    dj: MixerSource[];
    game: MixerSource[];
    mics: MixerSource[];
}

function pad2(n: number) {
    return String(n).padStart(2, '0');
}

// Read names first, then the mix settings of the sources the checks care
// about. Sources are found by name, as FIM's scenes name them: the bus named
// "Stream" (else Bus 1), "DJ" channels (not "Stream DJ"), match sounds on the
// aux return (17+18, "vMix PC") or channels named vMix/FMS/Game, and the
// mics on channels 1 and 2.
async function readMixer(host: string): Promise<MixerState> {
    const names = [
        ...Array.from(
            { length: 16 },
            (_, i) => `/ch/${pad2(i + 1)}/config/name`
        ),
        '/rtn/aux/config/name',
        ...Array.from({ length: 6 }, (_, i) => `/bus/${i + 1}/config/name`),
    ];
    const got = await queryXair(host, names);
    const empty: MixerState = {
        at: Date.now(),
        reachable: false,
        streamBus: 1,
        streamBusName: 'Bus 1',
        dj: [],
        game: [],
        mics: [],
    };
    if (got.size === 0) return empty;

    const name = (a: string) => String(got.get(a) ?? '').trim();
    let streamBus = 1;
    for (let b = 1; b <= 6; b += 1) {
        if (/stream/i.test(name(`/bus/${b}/config/name`))) {
            streamBus = b;
            break;
        }
    }
    const channels: MixerSource[] = Array.from({ length: 16 }, (_, i) => ({
        name: name(`/ch/${pad2(i + 1)}/config/name`) || `Ch ${i + 1}`,
        path: `/ch/${pad2(i + 1)}`,
        meter: i,
    }));
    const aux: MixerSource = {
        name: name('/rtn/aux/config/name') || 'Aux (17+18)',
        path: '/rtn/aux',
        meter: 16,
    };
    const dj = channels.filter(
        (c) => /\bdj\b/i.test(c.name) && !/stream/i.test(c.name)
    );
    let game = channels.filter((c) => /vmix|vmic|fms|game/i.test(c.name));
    if (/vmix|fms|game|pc/i.test(aux.name) || game.length === 0)
        game = [aux, ...game];
    const mics = channels.slice(0, 2);

    const sources = [...dj, ...game, ...mics];
    const sendPad = pad2(streamBus);
    const mixAddrs = sources.flatMap((s) => [
        `${s.path}/mix/on`,
        `${s.path}/mix/fader`,
        `${s.path}/mix/lr`,
        `${s.path}/mix/${sendPad}/level`,
    ]);
    const mix = await queryXair(host, mixAddrs);
    sources.forEach((s) => {
        const v = (k: string) => mix.get(`${s.path}/mix/${k}`);
        if (v('on') !== undefined) s.on = Number(v('on')) === 1;
        if (v('fader') !== undefined) s.faderDb = levelToDb(Number(v('fader')));
        if (v('lr') !== undefined) s.lr = Number(v('lr')) === 1;
        const send = v(`${sendPad}/level`);
        if (send !== undefined) s.streamSendDb = levelToDb(Number(send));
    });
    return {
        at: Date.now(),
        reachable: true,
        streamBus,
        streamBusName:
            name(`/bus/${streamBus}/config/name`) || `Bus ${streamBus}`,
        dj,
        game,
        mics,
    };
}

// p-th percentile of a list (0..1), or null when empty.
function percentile(xs: number[], p: number): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export default class Checks extends EventEmitter {
    private static instance: Checks;

    private results = new Map<string, CheckResult>();

    private timer: ReturnType<typeof setTimeout> | null = null;

    private since = new Map<string, number>();

    private notified = new Set<string>();

    private vmix: any = null;

    private bandwidthAt = 0;

    private bandwidth: Awaited<ReturnType<typeof getVmixBandwidth>> | null =
        null;

    private mixer: MixerState | null = null;

    private meters = new XairMeters();

    // The match in play at the last tick, to catch starts and ends.
    private lastMatch: string | null = null;

    // Match start sound: samples of the FMS input meter after a start.
    private buzzer: {
        label: string;
        until: number;
        peakDb: number;
        busPeakDb: number;
        streaming: boolean;
    } | null = null;

    // Set when the last match start sound reached the FMS input but not Bus
    // A (the stream); kept until the next match start.
    private busMissedStart: string | null = null;

    // Mics and match-sound levels on the stream bus during the current match.
    private balance: { label: string; mic: number[]; game: number[] } | null =
        null;

    private balanceTimer: ReturnType<typeof setInterval> | null = null;

    public start() {
        DEFS.forEach((d) =>
            this.results.set(d.id, {
                ...d,
                state: 'unknown',
                detail: ['match-buzzer', 'mic-balance'].includes(d.id)
                    ? 'No match yet'
                    : '',
                ignoredUntil: null,
            })
        );
        const loop = async () => {
            try {
                await this.tick();
            } catch (e) {
                log.warn('Checks tick failed', e);
            }
            // Fast while the match start sound is sampled, 2 s in a match,
            // 5 s otherwise.
            let wait = AutoAV.Instance.matchInPlay() ? 2000 : 5000;
            if (this.buzzer) wait = 500;
            this.timer = setTimeout(loop, wait);
        };
        loop();
    }

    public list(): CheckResult[] {
        return DEFS.map((d) => this.results.get(d.id)!).filter(Boolean);
    }

    public ignore(id: string) {
        const ignored: Record<string, number> = {
            ...(getStore().get('checks.ignoredUntil', {}) as Record<
                string,
                number
            >),
        };
        ignored[id] = Date.now() + IGNORE_MS;
        getStore().set('checks.ignoredUntil', ignored);
        this.publish();
    }

    public unignore(id: string) {
        const ignored: Record<string, number> = {
            ...(getStore().get('checks.ignoredUntil', {}) as Record<
                string,
                number
            >),
        };
        delete ignored[id];
        getStore().set('checks.ignoredUntil', ignored);
        this.publish();
    }

    // True once `cond` has held for `ms`.
    private held(id: string, cond: boolean, ms: number): boolean {
        if (!cond) {
            this.since.delete(id);
            return false;
        }
        const t = this.since.get(id) ?? Date.now();
        this.since.set(id, t);
        return Date.now() - t >= ms;
    }

    private set(id: string, state: CheckState, detail: string) {
        const r = this.results.get(id);
        if (r) this.results.set(id, { ...r, state, detail });
    }

    private async tick() {
        const now = Date.now();
        const match = AutoAV.Instance.matchInPlay();

        this.vmix = await VmixService.Instance.GetBase()
            .then((p) => p?.vmix ?? null)
            .catch(() => null);
        if (now - this.bandwidthAt >= 5000) {
            this.bandwidthAt = now;
            this.bandwidth = await getVmixBandwidth().catch(() => null);
        }
        const host = HWPing.Instance.mixerAddress();
        if (host && (!this.mixer || now - this.mixer.at >= 10000)) {
            this.mixer = await readMixer(host).catch(() => null);
        }

        // Match start/end: buzzer window, meter subscription, balance.
        const label = match?.label ?? null;
        if (label !== this.lastMatch) {
            if (this.lastMatch) this.endMatch();
            if (label) this.beginMatch(label, host);
            this.lastMatch = label;
        }

        const v = this.vmix;
        const streaming = !!v && truthy(v.streaming);
        const recording = !!v && truthy(v.recording);
        this.checkStream(v, match, streaming);
        this.checkRecording(v, match, recording);
        this.checkStreamAudio(v, match, streaming);
        this.checkLoudness();
        this.checkMixer();
        this.checkMatchSounds(v);
        this.checkBuzzer(v);
        this.checkCaptions(v);
        this.publish();
    }

    // #region checks

    private checkStream(
        v: any,
        match: { label: string } | null,
        streaming: boolean
    ) {
        if (!v) {
            this.set('stream-match', 'unknown', 'vMix not answering');
            this.set('stream-health', 'unknown', 'vMix not answering');
            return;
        }
        if (this.held('stream-match', !!match && !streaming, 5000)) {
            this.set(
                'stream-match',
                'critical',
                `${match!.label} running, not streaming`
            );
        } else if (!match) {
            // Between matches there is nothing to check.
            this.set('stream-match', 'unknown', 'No match');
        } else if (streaming) {
            this.set('stream-match', 'ok', 'Streaming');
        } else {
            this.set('stream-match', 'ok', `${match.label} starting`);
        }

        if (!streaming) {
            this.held('stream-stall', false, 0);
            this.set('stream-health', 'ok', 'Not streaming');
            return;
        }
        const bw = this.bandwidth;
        if (!bw || !bw.supported || bw.warming) {
            this.set('stream-health', 'unknown', 'No stream data yet');
            return;
        }
        // getVmixBandwidth lists only streams whose log grew since its last
        // read, so a stalled stream drops out of the list.
        const live = bw.streams;
        const kbps = live.reduce((t, s) => t + (s.liveKbps ?? 0), 0);
        // Stalled: no stream log growing (vMix's ffmpeg stopped writing), or
        // every stream running under real time. Bitrate is not used: the
        // stream is variable bitrate, so a static scene is legitimately low.
        const stalled =
            live.length === 0 ||
            live.every((s) => s.speed !== null && s.speed < 0.9);
        const mbps = (k: number) => (k / 1000).toFixed(1);
        if (this.held('stream-stall', stalled, 20000)) {
            this.set(
                'stream-health',
                'critical',
                live.length
                    ? `Stalled: ${Math.min(
                          ...live.map((x) => x.speed ?? 1)
                      ).toFixed(2)}x real time`
                    : 'Stalled: no data going out'
            );
        } else {
            this.set(
                'stream-health',
                'ok',
                `${live.length} stream${live.length === 1 ? '' : 's'}, ${mbps(
                    kbps
                )} Mbps`
            );
        }
    }

    private checkRecording(
        v: any,
        match: { label: string } | null,
        recording: boolean
    ) {
        if (!v) {
            this.set('recording-match', 'unknown', 'vMix not answering');
            return;
        }
        if (this.held('recording-match', !!match && !recording, 10000)) {
            this.set(
                'recording-match',
                'warning',
                `${match!.label} running, not recording`
            );
        } else if (!match) {
            this.set('recording-match', 'unknown', 'No match');
        } else {
            this.set('recording-match', 'ok', 'Recording');
        }
    }

    private checkStreamAudio(
        v: any,
        match: { label: string } | null,
        streaming: boolean
    ) {
        const bus = v?.audio?.busA;
        if (!v) {
            this.set('stream-audio', 'unknown', 'vMix not answering');
            return;
        }
        // FIM streams and records Bus A. With no Bus A set up in vMix's
        // audio mixer, the stream has no audio at all.
        if (!bus) {
            this.set(
                'stream-audio',
                'critical',
                'No Bus A in vMix audio mixer'
            );
            return;
        }
        const db = Math.max(meterDb(bus.meterF1), meterDb(bus.meterF2));
        const live = streaming && !!match;
        if (live && truthy(bus.muted)) {
            this.set('stream-audio', 'critical', 'Bus A muted');
        } else if (this.busMissedStart) {
            this.set('stream-audio', 'critical', this.busMissedStart);
        } else if (this.held('stream-clip', live && db > -0.5, 6000)) {
            this.set('stream-audio', 'warning', 'Bus A clipping');
        } else {
            this.set(
                'stream-audio',
                'ok',
                Number.isFinite(db) ? `${Math.round(db)} dB` : 'Silent'
            );
        }
    }

    private checkLoudness() {
        const folder = AutoAV.Instance.getStatus().saveFolder;
        const rec = listMatches(folder).find((m) => m.loudness);
        if (!rec?.loudness) {
            this.set('stream-loudness', 'ok', 'No measurement yet');
            return;
        }
        const { lufs, truePeak } = rec.loudness;
        const name = rec.ftc?.shortName ?? `${rec.level} ${rec.matchNumber}`;
        const text = `${name}: ${
            Number.isFinite(lufs) ? lufs.toFixed(1) : '-inf'
        } LUFS${
            truePeak !== null && Number.isFinite(truePeak)
                ? `, peak ${truePeak.toFixed(1)} dBTP`
                : ''
        }`;
        let state: CheckState = 'ok';
        if (lufs < LUFS_LOW || lufs > LUFS_HIGH) state = 'warning';
        if (truePeak !== null && truePeak > TRUE_PEAK_MAX) state = 'warning';
        this.set('stream-loudness', state, text);
    }

    private checkMixer() {
        const m = this.mixer;
        if (!HWPing.Instance.mixerAddress()) {
            ['dj-stream'].forEach((id) =>
                this.set(id, 'unknown', 'No mixer address')
            );
            return;
        }
        if (!m || !m.reachable) {
            this.set('dj-stream', 'unknown', 'X-Air not answering');
            return;
        }
        if (!m.dj.length) {
            this.set('dj-stream', 'ok', 'No DJ channel');
            return;
        }
        const leaking = m.dj.filter(
            (c) => c.on !== false && (c.streamSendDb ?? -Infinity) > OFF_DB
        );
        if (leaking.length) {
            const c = leaking[0];
            this.set(
                'dj-stream',
                'critical',
                `${c.name} sent to ${m.streamBusName}: ${Math.round(
                    c.streamSendDb!
                )} dB`
            );
        } else {
            this.set('dj-stream', 'ok', `Off ${m.streamBusName}`);
        }
    }

    // FMS (or FTC Live) display input in vMix: unmuted and on Master. On the
    // X-Air, at least one match-sound source unmuted, in the venue (main LR,
    // fader up) and on the stream bus. The venue matters more than the
    // stream, so a missing main mix is critical and a missing stream send a
    // warning.
    private checkMatchSounds(v: any) {
        const problems: { state: CheckState; text: string }[] = [];
        const input = this.displayInput(v);
        if (v && !input) {
            problems.push({
                state: 'warning',
                text: 'No FMS / Audience Display input in vMix',
            });
        } else if (input) {
            if (truthy(input.muted))
                problems.push({
                    state: 'critical',
                    text: `${input.title} muted in vMix`,
                });
            else if (
                !String(input.audiobusses ?? '')
                    .split(',')
                    .includes('M')
            )
                problems.push({
                    state: 'critical',
                    text: `${input.title} not on Master in vMix`,
                });
        }
        const m = this.mixer;
        if (m?.reachable && m.game.length) {
            const venue = m.game.filter(
                (s) =>
                    s.on !== false &&
                    s.lr !== false &&
                    (s.faderDb ?? 0) > OFF_DB
            );
            const stream = venue.filter(
                (s) => (s.streamSendDb ?? -Infinity) > OFF_DB
            );
            const g = m.game[0];
            if (!venue.length) {
                let why = 'not in the venue mix';
                if (g.on === false) why = 'muted';
                else if ((g.faderDb ?? 0) <= OFF_DB) why = 'fader down';
                problems.push({
                    state: 'critical',
                    text: `${g.name} ${why} on X-Air`,
                });
            } else if (!stream.length) {
                problems.push({
                    state: 'warning',
                    text: `${venue[0].name} not sent to ${m.streamBusName}`,
                });
            }
        }
        if (!v && !m?.reachable) {
            this.set('match-sounds', 'unknown', 'vMix and X-Air not answering');
            return;
        }
        if (!problems.length) {
            this.set(
                'match-sounds',
                'ok',
                m?.reachable ? 'vMix and X-Air' : 'vMix only'
            );
            return;
        }
        const worst =
            problems.find((p) => p.state === 'critical') ?? problems[0];
        this.set('match-sounds', worst.state, worst.text);
    }

    // The FMS / audience display browser input whose sounds are the match
    // sounds: "FMS" at FRC events, "Audience Display" at FTC events.
    // eslint-disable-next-line class-methods-use-this
    private displayInput(v: any): any {
        const inputs = list<any>(v?.inputs?.input);
        return (
            inputs.find((i) => String(i.title) === 'FMS') ??
            inputs.find((i) => /audience display|^fms/i.test(String(i.title)))
        );
    }

    private checkBuzzer(v: any) {
        const b = this.buzzer;
        if (!b) return;
        const input = this.displayInput(v);
        if (input) {
            b.peakDb = Math.max(
                b.peakDb,
                meterDb(input.meterF1),
                meterDb(input.meterF2)
            );
        }
        const bus = v?.audio?.busA;
        if (bus) {
            b.busPeakDb = Math.max(
                b.busPeakDb,
                meterDb(bus.meterF1),
                meterDb(bus.meterF2)
            );
        }
        if (Date.now() < b.until) return;
        if (!input) this.set('match-buzzer', 'unknown', 'No FMS input in vMix');
        else if (b.peakDb < -50)
            this.set('match-buzzer', 'warning', `No sound at ${b.label} start`);
        else this.set('match-buzzer', 'ok', `Heard at ${b.label} start`);
        // The start sound played (FMS input) but never reached the stream
        // mix: the path vMix -> X-Air -> Bus A is broken. A quiet room cannot
        // trip this, unlike a silence timer.
        this.busMissedStart =
            b.streaming && b.peakDb >= -50 && b.busPeakDb < -50
                ? `No ${b.label} start sound on Bus A`
                : null;
        this.buzzer = null;
    }

    private checkCaptions(v: any) {
        if (!v) {
            this.set('captions', 'unknown', 'vMix not answering');
            return;
        }
        const input = list<any>(v.inputs?.input).find((i) =>
            /live captions/i.test(String(i.title))
        );
        const overlays = list<any>(v.overlays?.overlay);
        const onOverlay =
            !!input &&
            overlays.some(
                (o) =>
                    String(typeof o === 'object' ? o['#text'] : o) ===
                    String(input.number)
            );
        let problem = '';
        if (!LiveCaptions.Instance.isRunning())
            problem = 'Live Captions stopped';
        else if (!input) problem = 'No Live Captions input in vMix';
        else if (!onOverlay) problem = 'Live Captions not on an overlay';
        // Captions are set up for the whole event, so a problem counts
        // whether or not a match is on.
        if (problem) this.set('captions', 'warning', problem);
        else this.set('captions', 'ok', 'On overlay');
    }

    // #endregion

    // #region match start / end

    private beginMatch(label: string, host: string | null) {
        this.buzzer = {
            label,
            until: Date.now() + 4000,
            peakDb: -Infinity,
            busPeakDb: -Infinity,
            streaming: !!this.vmix && truthy(this.vmix.streaming),
        };
        if (!host || !this.mixer?.reachable) return;
        this.meters.start(host);
        this.balance = { label, mic: [], game: [] };
        // Sample the meter stream twice a second while the match is in play.
        this.balanceTimer = setInterval(() => this.sampleBalance(), 500);
    }

    private endMatch() {
        if (this.balanceTimer) clearInterval(this.balanceTimer);
        this.balanceTimer = null;
        this.meters.stop();
        const b = this.balance;
        this.balance = null;
        if (!b) return;
        // Typical loud level of each while it is sounding.
        const mic = percentile(b.mic, 0.9);
        const game = percentile(b.game, 0.9);
        if (
            mic === null ||
            game === null ||
            b.mic.length < 6 ||
            b.game.length < 6
        ) {
            this.set('mic-balance', 'ok', `Not enough sound in ${b.label}`);
            return;
        }
        const diff = Math.round(mic - game);
        if (diff > BALANCE_DB)
            this.set(
                'mic-balance',
                'warning',
                `Mics ${diff} dB over match sounds (${b.label})`
            );
        else if (-diff > BALANCE_DB)
            this.set(
                'mic-balance',
                'warning',
                `Match sounds ${-diff} dB over mics (${b.label})`
            );
        else
            this.set(
                'mic-balance',
                'ok',
                `${Math.abs(diff)} dB apart (${b.label})`
            );
    }

    // Each source's level on the stream bus: its meter plus fader and send
    // (rough: assumes post-fader sends). Only samples where the source is
    // sounding count, so a mic between announcements is not "quiet".
    private sampleBalance() {
        const b = this.balance;
        const m = this.mixer;
        const levels = this.meters.latest;
        if (
            !b ||
            !m ||
            !levels.length ||
            Date.now() - this.meters.lastAt > 2000
        )
            return;
        const onBus = (s: MixerSource) => {
            const raw = levels[s.meter];
            if (raw === undefined || raw < -50 || s.on === false) return null;
            return raw + (s.faderDb ?? 0) + (s.streamSendDb ?? -Infinity);
        };
        const best = (xs: MixerSource[]) =>
            xs
                .map(onBus)
                .filter((x): x is number => x !== null && Number.isFinite(x));
        const mic = best(m.mics);
        const game = best(m.game);
        if (mic.length) b.mic.push(Math.max(...mic));
        if (game.length) b.game.push(Math.max(...game));
    }

    // #endregion

    private publish() {
        const now = Date.now();
        const ignored: Record<string, number> = {
            ...(getStore().get('checks.ignoredUntil', {}) as Record<
                string,
                number
            >),
        };
        let changed = false;
        Object.keys(ignored).forEach((id) => {
            if (ignored[id] <= now) {
                delete ignored[id];
                changed = true;
            }
        });
        if (changed) getStore().set('checks.ignoredUntil', ignored);

        this.results.forEach((r, id) => {
            const until = ignored[id] ?? null;
            const next = { ...r, ignoredUntil: until };
            this.results.set(id, next);
            const failing = r.state === 'warning' || r.state === 'critical';
            if (failing && !until && !this.notified.has(id)) {
                this.notified.add(id);
                this.emit('alert', next);
            }
            if (!failing) this.notified.delete(id);
        });
        this.emit('checks', this.list());
    }

    public static get Instance(): Checks {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
