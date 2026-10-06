import { EventEmitter } from 'events';
import log from 'electron-log';
import VmixService from '../../services/VmixService';
import AutoAV from '../addons/autoav';
import LiveCaptions from '../addons/live-captions';
import HWPing from '../addons/hw-ping';
import getVmixBandwidth, { streamKeyFromUrl } from '../vmixBandwidth';
import { listMatches } from '../recordings/matchStore';
import { getStore } from '../store';
import { levelToDb, queryXair, XairMeters } from './xair';
import { readStreamSettings, VmixStreamSettings } from './vmixSettings';
import {
    fetchAndParseAudioDevices,
    isXairOut,
    setDefaultAudioDevice,
    setVolumePercent,
    unmuteDevice,
} from '../events/HWCheck';
import { ParsedSoundOutput } from '../../models/SoundVolumeViewOutput';
import {
    CaptionPushStatus,
    enableCaptionPush,
    getCaptionPushStatus,
    keyFromCaptionUrl,
    setCaptionKey,
} from './captionsYoutube';
import { CheckResult, CheckState, isAlerting } from '../../models/Checks';

// Stream and audio checks for a live event. Every check reads state the cart
// already has (the vMix API, vMix's stream logs, the X-Air over OSC, FMS or
// FTC Live match state, the match manifest) and nothing records or decodes
// audio or video live. Light by design:
//  - vMix API: every 2 s during a match, every 5 s otherwise
//  - stream logs: every 5 s (ffmpeg's speed=, not bitrate: the stream is VBR)
//  - vMix autosave (last.vmix): re-read only when vMix rewrites it, ~1/min
//  - X-Air settings: ~30 tiny UDP queries every 10 s (network, not USB)
//  - X-Air meters: subscribed only while a qual/playoff match is in play
//  - loudness: one audio-only ffmpeg pass per finished match (loudness.ts)
// A check that is failing raises a banner and a Windows notification once;
// "Ignore" silences that one check for 6 h (kept in the store across restarts).

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

type Def = Pick<CheckResult, 'id' | 'group' | 'label'> & {
    doc?: string;
    hint?: string;
};

const DOCS = 'https://docs.fimav.us/docs';

type Fix = { label: string; run: () => Promise<unknown> };

const vmixFn =
    (fn: string, params: Record<string, string> = {}): Fix['run'] =>
    () =>
        VmixService.Instance.Function(fn, params);

// "Live Captions updating" / "starting" while start() is on its way, else
// null. At app launch it checks for an update first, then waits for :3000.
const liveCaptionsWait = (): string | null => {
    const phase = LiveCaptions.Instance.getPhase();
    if (phase === 'updating') return 'Live Captions updating';
    if (phase === 'starting') return 'Live Captions starting';
    return null;
};

// The overlay channel FIM puts Live Captions on.
const CAPTIONS_OVERLAY = 8;

const DEFS: Def[] = [
    {
        id: 'hw-network',
        group: 'Hardware',
        label: 'Network',
        doc: `${DOCS}/troubleshooting-guides/stream-wont-start/#1-check-internet-connection`,
    },
    {
        id: 'hw-ip',
        group: 'Hardware',
        label: 'IP config',
        doc: `${DOCS}/setting-up-the-fim-av-system/#check-network-configuration`,
    },
    { id: 'hw-switch', group: 'Hardware', label: 'Switch' },
    { id: 'hw-mixer', group: 'Hardware', label: 'Mixer' },
    { id: 'hw-camera1', group: 'Hardware', label: 'Camera 1' },
    { id: 'hw-camera2', group: 'Hardware', label: 'Camera 2' },
    {
        id: 'stream-match',
        group: 'Stream',
        label: 'Stream during match',
        doc: `${DOCS}/troubleshooting-guides/stream-wont-start/`,
    },
    {
        id: 'stream-health',
        group: 'Stream',
        label: 'Stream health',
        doc: `${DOCS}/troubleshooting-guides/stream-wont-start/#1-check-internet-connection`,
    },
    {
        id: 'stream-bus',
        group: 'Stream',
        label: 'Stream audio source',
        hint:
            'Bus A is the stream mix from the X-Air (mics and match sounds). ' +
            'Master leaves the mics out of the stream.',
        doc: `${DOCS}/troubleshooting-guides/no-audio/#3-check-stream-settings-in-vmix`,
    },
    {
        id: 'recording-match',
        group: 'Recording',
        label: 'Recording during match',
    },
    {
        id: 'recording-bus',
        group: 'Recording',
        label: 'Recording audio source',
        hint:
            'Bus A is the stream mix from the X-Air (mics and match sounds). ' +
            'Master leaves the mics out of the match recordings.',
        doc: `${DOCS}/setting-up-the-fim-av-system/#verify-stream`,
    },
    {
        id: 'stream-audio',
        group: 'Audio',
        label: 'Stream audio (Bus A)',
        doc: `${DOCS}/troubleshooting-guides/no-audio/#4-check-levels-in-vmix`,
    },
    {
        id: 'stream-loudness',
        group: 'Audio',
        label: 'Stream loudness',
        doc: `${DOCS}/audio-volume/`,
    },
    {
        id: 'dj-stream',
        group: 'Audio',
        label: 'DJ on stream bus',
        doc: `${DOCS}/troubleshooting-guides/no-audio/#1-test-using-game-sounds-or-a-microphone`,
    },
    {
        id: 'match-sounds',
        group: 'Audio',
        label: 'Match sounds',
        doc: `${DOCS}/troubleshooting-guides/no-game-sounds/`,
    },
    {
        id: 'windows-audio',
        group: 'Audio',
        label: 'Windows audio',
        hint:
            'Windows plays the match sounds through its default device; ' +
            "the X-Air's OUT 1-2 must be default, unmuted and at 100%.",
        doc: `${DOCS}/troubleshooting-guides/no-game-sounds/`,
    },
    {
        id: 'match-buzzer',
        group: 'Audio',
        label: 'Match start sound',
        doc: `${DOCS}/troubleshooting-guides/no-game-sounds/`,
    },
    {
        id: 'mic-balance',
        group: 'Audio',
        label: 'Mics vs match sounds',
        doc: `${DOCS}/audio-volume/#helpful-guide-to-implementing-and-auditing-yourself`,
    },
    {
        id: 'captions',
        group: 'Captions',
        label: 'Captions overlay',
        doc: `${DOCS}/software-guides/captions/#adding-the-captions-to-vmix`,
    },
    {
        id: 'captions-youtube',
        group: 'Captions',
        label: 'YouTube captions',
        doc: `${DOCS}/software-guides/captions/#youtube-caption-push`,
    },
    {
        id: 'stream-output',
        group: 'Captions',
        label: 'Captions off stream',
        hint:
            'Output 1 and overlay 8 carry the venue captions. On the live ' +
            'stream or the match recordings they are baked into the video; ' +
            'YouTube gets its captions from Live Captions instead.',
        doc: `${DOCS}/software-guides/captions/#hiding-captions-from-streamrecording`,
    },
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

    private fixes = new Map<string, Fix>();

    private settings: VmixStreamSettings | null = null;

    private captionPush: CaptionPushStatus | null = null;

    private captionPushAt = 0;

    // Windows' X-Air playback device, from SoundVolumeView; undefined until
    // the first read, null when it is not there.
    private winAudio: ParsedSoundOutput | null | undefined;

    private winAudioAt = 0;

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
                doc: d.doc ?? null,
                hint: d.hint ?? null,
                ignoredUntil: null,
                fix: null,
            })
        );
        const loop = async () => {
            try {
                await this.runTick();
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

    // `fix` is a one-click repair for this exact problem; any later set()
    // without one clears it.
    private set(id: string, state: CheckState, detail: string, fix?: Fix) {
        const r = this.results.get(id);
        if (!r) return;
        if (fix) this.fixes.set(id, fix);
        else this.fixes.delete(id);
        this.results.set(id, { ...r, state, detail, fix: fix?.label ?? null });
    }

    public async fix(id: string): Promise<void> {
        const f = this.fixes.get(id);
        if (!f) throw new Error('Nothing to fix');
        log.info(`checks: fix ${id}: ${f.label}`);
        await f.run();
        // Check again now, not on the next loop, so the result (and the
        // button) updates as soon as the fix is in.
        this.captionPushAt = 0;
        this.winAudioAt = 0;
        this.mixer = null;
        await this.runTick();
    }

    // One tick at a time: a fix's re-check and the loop share this.
    private ticking: Promise<void> = Promise.resolve();

    private runTick(): Promise<void> {
        this.ticking = this.ticking
            .catch(() => undefined)
            .then(() => this.tick());
        return this.ticking;
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

        // One SoundVolumeView run a minute (it lists every audio device).
        if (process.platform === 'win32' && now - this.winAudioAt >= 60000) {
            this.winAudioAt = now;
            this.winAudio = await fetchAndParseAudioDevices(log)
                .then((ds) => ds.find(isXairOut) ?? null)
                .catch(() => undefined);
        }
        // vMix's autosave; only re-read when vMix has rewritten it.
        // With vMix closed the file holds the last session's settings, which
        // may not be what vMix opens next: only read it while vMix answers.
        this.settings = this.vmix ? readStreamSettings() : null;
        if (now - this.captionPushAt >= 10000) {
            this.captionPushAt = now;
            this.captionPush = LiveCaptions.Instance.isRunning()
                ? await getCaptionPushStatus()
                : null;
        }

        const v = this.vmix;
        const streaming = !!v && truthy(v.streaming);
        const recording = !!v && truthy(v.recording);
        this.checkHardware();
        this.checkStream(v, match, streaming);
        this.checkStreamBus(v, streaming);
        this.checkStreamOutput();
        this.checkRecordingBus();
        this.checkRecording(v, match, recording);
        this.checkStreamAudio(v, match, streaming);
        this.checkLoudness();
        this.checkMixer();
        this.checkMatchSounds(v);
        this.checkWindowsAudio();
        this.checkBuzzer(v);
        this.checkCaptions(v);
        this.checkCaptionsYoutube(streaming);
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
                `${match!.label} running, not streaming`,
                { label: 'Start stream', run: vmixFn('StartStreaming') }
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
            this.set('stream-health', 'unknown', 'Not streaming');
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

    // The status bar's hardware pings (hw-ping.ts, every 10 s) and its
    // network interface check (every 60 s), shown here as checks.
    private checkHardware() {
        const hw = HWPing.Instance;
        const st = hw.currentStatus;
        const pinged = hw.lastPingAt > 0;
        const dev = (id: string, alive: boolean, state: CheckState) => {
            if (!pinged) this.set(id, 'unknown', 'Not pinged yet');
            else if (alive) this.set(id, 'ok', 'Online');
            else this.set(id, state, 'No reply');
        };
        dev('hw-network', st.internet, 'critical');
        dev('hw-switch', st.switch, 'warning');
        dev('hw-mixer', st.mixer, 'warning');
        dev('hw-camera1', st.camera1, 'warning');
        dev('hw-camera2', st.camera2, 'warning');
        // hw-ping's messages end in advice ("... Check cable or DHCP.");
        // the first clause is the finding.
        const first = (msgs: string[]) =>
            msgs[0].split('. ')[0].replace(/\.$/, '') +
            (msgs.length > 1 ? ` (+${msgs.length - 1})` : '');
        if (st.ip_errors.length)
            this.set('hw-ip', 'critical', first(st.ip_errors));
        else if (st.ip_warnings.length)
            this.set('hw-ip', 'warning', first(st.ip_warnings));
        else this.set('hw-ip', 'ok', 'Expected ranges');
    }

    // Two sources. While live, the audio device each stream's ffmpeg reads,
    // from its log's command line: the stream as it runs. Always, the stream
    // settings in vMix's autosave, so a wrong bus shows before going live.
    // Anything other than Bus A puts the venue mix on the stream.
    private checkStreamBus(v: any, streaming: boolean) {
        if (!v) {
            this.set('stream-bus', 'unknown', 'vMix not answering');
            return;
        }
        const setting = this.settings?.audioBus ?? null;
        const live = streaming
            ? (this.bandwidth?.streams ?? []).filter((s) => s.audioBus)
            : [];
        const wrong = live.filter((s) => s.audioBus !== 'Bus A');
        if (wrong.length) {
            this.set(
                'stream-bus',
                'critical',
                wrong
                    .map((s) => `Stream ${s.index} on ${s.audioBus}, not Bus A`)
                    .join(', ')
            );
        } else if (setting && setting !== 'Bus A') {
            // Live on Bus A but changed in settings: the next start is wrong.
            this.set(
                'stream-bus',
                live.length ? 'warning' : 'critical',
                `Stream settings on ${setting}, not Bus A`
            );
        } else if (live.length) {
            this.set(
                'stream-bus',
                'ok',
                live.map((s) => `Stream ${s.index} on Bus A`).join(', ')
            );
        } else if (setting) {
            this.set('stream-bus', 'ok', 'Stream settings on Bus A');
        } else if (!streaming) {
            this.set('stream-bus', 'unknown', 'No vMix settings file');
        }
        // Live with no stream data (stalled or first read): keep the last.
    }

    // FIM streams and records (recorder 1) Output 2, and Output 2 leaves
    // out overlay 8 (Live Captions, which go to YouTube as real captions,
    // not burned in).
    private checkStreamOutput() {
        const st = this.settings;
        if (!this.vmix) {
            this.set('stream-output', 'unknown', 'vMix not answering');
            return;
        }
        if (!st || st.output === null) {
            this.set('stream-output', 'unknown', 'No vMix settings file');
            return;
        }
        const problems: string[] = [];
        if (st.output !== 2)
            problems.push(`Stream on Output ${st.output}, not Output 2`);
        if (st.recordOutput !== null && st.recordOutput !== 2)
            problems.push(
                `Recorder 1 on Output ${st.recordOutput}, not Output 2`
            );
        if (st.output2Overlays?.includes(CAPTIONS_OVERLAY))
            problems.push(`Overlay ${CAPTIONS_OVERLAY} (captions) on Output 2`);
        if (problems.length)
            this.set('stream-output', 'warning', problems.join(', '));
        else
            this.set(
                'stream-output',
                'ok',
                `Stream and recorder 1 on Output 2, no overlay ${CAPTIONS_OVERLAY}`
            );
    }

    // Recorder 1's audio, from vMix's autosave: Bus A, as for the stream.
    private checkRecordingBus() {
        const bus = this.settings?.recordAudioBus ?? null;
        if (!this.vmix)
            this.set('recording-bus', 'unknown', 'vMix not answering');
        else if (!bus)
            this.set('recording-bus', 'unknown', 'No vMix settings file');
        else if (bus !== 'Bus A')
            this.set(
                'recording-bus',
                'warning',
                `Recorder 1 on ${bus}, not Bus A`
            );
        else this.set('recording-bus', 'ok', 'Recorder 1 on Bus A');
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
        const unmute: Fix = {
            label: 'Unmute',
            run: vmixFn('BusXAudioOn', { Value: 'A' }),
        };
        if (truthy(bus.muted)) {
            // Muted before going live is a warning: the stream (and the
            // recordings, also on Bus A) would start silent.
            this.set(
                'stream-audio',
                live ? 'critical' : 'warning',
                'Bus A muted',
                unmute
            );
        } else if (!streaming) {
            this.set('stream-audio', 'unknown', 'Not streaming');
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
            this.set('stream-loudness', 'unknown', 'No measurement yet');
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
            this.set('dj-stream', 'unknown', 'No DJ channel on X-Air');
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
        const problems: { state: CheckState; text: string; fix?: Fix }[] = [];
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
                    fix: {
                        label: 'Unmute',
                        run: vmixFn('AudioOn', { Input: String(input.key) }),
                    },
                });
            else if (
                !String(input.audiobusses ?? '')
                    .split(',')
                    .includes('M')
            )
                problems.push({
                    state: 'critical',
                    text: `${input.title} not on Master in vMix`,
                    fix: {
                        label: 'Add to Master',
                        run: vmixFn('AudioBusOn', {
                            Input: String(input.key),
                            Value: 'M',
                        }),
                    },
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
        this.set('match-sounds', worst.state, worst.text, worst.fix);
    }

    // Setup's audio check (events/HWCheck.ts), kept running: the X-Air's
    // OUT 1-2 is Windows' default playback device, unmuted, at 100%.
    private checkWindowsAudio() {
        const d = this.winAudio;
        if (process.platform !== 'win32') {
            this.set('windows-audio', 'unknown', 'Not Windows');
            return;
        }
        if (d === undefined) {
            this.set('windows-audio', 'unknown', 'Not read yet');
            return;
        }
        if (d === null) {
            // Off a cart (no cart number) there is no X-Air to expect.
            if (HWPing.Instance.mixerAddress())
                this.set('windows-audio', 'warning', 'No X-Air OUT 1-2 device');
            else this.set('windows-audio', 'unknown', 'No X-Air (not a cart)');
            return;
        }
        const id = d.control_id || d.name;
        const volume = parseInt(String(d.volume_percent).replace('%', ''), 10);
        if (d.default !== 'Render') {
            this.set('windows-audio', 'critical', 'X-Air OUT 1-2 not default', {
                label: 'Set as default',
                run: () => setDefaultAudioDevice(id, 'all'),
            });
        } else if (d.muted) {
            this.set('windows-audio', 'critical', 'X-Air OUT 1-2 muted', {
                label: 'Unmute',
                run: () => unmuteDevice(id),
            });
        } else if (Number.isFinite(volume) && volume < 100) {
            this.set(
                'windows-audio',
                'warning',
                `X-Air OUT 1-2 at ${volume}%, not 100%`,
                {
                    label: 'Set to 100%',
                    run: () => setVolumePercent(id, 100),
                }
            );
        } else {
            this.set('windows-audio', 'ok', 'X-Air OUT 1-2, default, 100%');
        }
    }

    // The FMS / audience display browser input whose sounds are the match
    // sounds: "FMS" at FRC events, "Audience Display" at FTC events.
    // eslint-disable-next-line class-methods-use-this
    private displayInput(v: any): any {
        const inputs = list<any>(v?.inputs?.input);
        return (
            inputs.find((i) => String(i.title) === 'FMS') ??
            inputs.find((i) => /^fms\b|audience/i.test(String(i.title)))
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
        const overlay = list<any>(v.overlays?.overlay).find(
            (o) => String(o?.number) === String(CAPTIONS_OVERLAY)
        );
        const onOverlay =
            !!input &&
            String(typeof overlay === 'object' ? overlay['#text'] : '') ===
                String(input.number);
        const lcWait = liveCaptionsWait();
        if (lcWait) {
            this.set('captions', 'unknown', lcWait);
            return;
        }
        let problem = '';
        let fix: Fix | undefined;
        if (!LiveCaptions.Instance.isRunning()) {
            problem = 'Live Captions stopped';
            fix = {
                label: 'Start',
                run: async () => {
                    if (!(await LiveCaptions.Instance.start()))
                        throw new Error('Live Captions did not start');
                },
            };
        } else if (!input) {
            problem = 'No Live Captions input in vMix';
            fix = {
                label: 'Add input',
                run: () => VmixService.Instance.AddLiveCaptionsInput(),
            };
        } else if (!onOverlay) {
            problem = `Live Captions not on overlay ${CAPTIONS_OVERLAY}`;
            fix = {
                label: `Put on overlay ${CAPTIONS_OVERLAY}`,
                run: vmixFn(`OverlayInput${CAPTIONS_OVERLAY}In`, {
                    Input: String(input.key),
                }),
            };
        }
        // Captions are set up for the whole event, so a problem counts
        // whether or not a match is on.
        if (problem) this.set('captions', 'warning', problem, fix);
        else this.set('captions', 'ok', `On overlay ${CAPTIONS_OVERLAY}`);
    }

    // live-captions sends captions to YouTube by the stream key. The key it
    // holds must be the one vMix streams with: the live stream's, or the
    // settings' before going live.
    private checkCaptionsYoutube(streaming: boolean) {
        if (!LiveCaptions.Instance.isRunning()) {
            this.set(
                'captions-youtube',
                'unknown',
                liveCaptionsWait() ?? 'Live Captions stopped'
            );
            return;
        }
        const p = this.captionPush;
        if (!p) {
            this.set(
                'captions-youtube',
                'unknown',
                'Live Captions not answering'
            );
            return;
        }
        const live = (this.bandwidth?.streams ?? []).find((s) =>
            /youtube/i.test(s.rtmpUrl)
        );
        const streamKey =
            (streaming && live ? streamKeyFromUrl(live.rtmpUrl) : null) ||
            this.settings?.youtubeKey ||
            null;
        const key = keyFromCaptionUrl(p.url);
        const setKey: Fix | undefined = streamKey
            ? { label: 'Set key', run: () => setCaptionKey(streamKey) }
            : undefined;
        if (!key) {
            this.set(
                'captions-youtube',
                'warning',
                'No YouTube caption key',
                setKey
            );
        } else if (streamKey && key !== streamKey) {
            this.set(
                'captions-youtube',
                'warning',
                'Caption key not the stream key',
                setKey
            );
        } else if (!p.enabled) {
            this.set('captions-youtube', 'warning', 'YouTube captions off', {
                label: 'Turn on',
                run: enableCaptionPush,
            });
        } else if (
            this.held('captions-push-error', streaming && !!p.lastError, 30000)
        ) {
            this.set('captions-youtube', 'warning', p.lastError!);
        } else {
            this.set('captions-youtube', 'ok', 'Key set');
        }
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
            this.set(
                'mic-balance',
                'unknown',
                `Not enough sound in ${b.label}`
            );
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
            const failing = isAlerting(next);
            if (failing && !this.notified.has(id)) {
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
