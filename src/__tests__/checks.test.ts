import Checks from '../main/checks/engine';
import { decodeReply, levelToDb } from '../main/checks/xair';
import { CheckResult } from '../models/Checks';

// The world the checks read, set per test.
let vmix: any = null;
let match: { label: string; level: string } | null = null;
let bandwidth: any = { supported: true, streams: [] };
let mixer = new Map<string, string | number>();
let captionsRunning = true;
let matches: any[] = [];
const store: Record<string, unknown> = {};

jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});
jest.mock('../services/VmixService', () => ({
    __esModule: true,
    default: { Instance: { GetBase: async () => (vmix ? { vmix } : null) } },
}));
jest.mock('../main/addons/autoav', () => ({
    __esModule: true,
    default: {
        Instance: {
            matchInPlay: () => match,
            getStatus: () => ({ saveFolder: '/event' }),
        },
    },
}));
jest.mock('../main/addons/live-captions', () => ({
    __esModule: true,
    default: { Instance: { isRunning: () => captionsRunning } },
}));
jest.mock('../main/addons/hw-ping', () => ({
    __esModule: true,
    default: { Instance: { mixerAddress: () => '192.168.25.13' } },
}));
jest.mock('../main/vmixBandwidth', () => ({
    __esModule: true,
    default: async () => bandwidth,
}));
jest.mock('../main/recordings/matchStore', () => ({
    listMatches: () => matches,
}));
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d: unknown) => (k in store ? store[k] : d),
        set: (k: string, v: unknown) => {
            store[k] = v;
        },
    }),
}));
jest.mock('../main/checks/xair', () => {
    const actual = jest.requireActual('../main/checks/xair');
    return {
        ...actual,
        queryXair: async (_h: string, addrs: string[]) =>
            new Map(
                addrs.filter((a) => mixer.has(a)).map((a) => [a, mixer.get(a)])
            ),
        XairMeters: class {
            latest: number[] = [];

            lastAt = 0;

            // eslint-disable-next-line class-methods-use-this
            start() {}

            // eslint-disable-next-line class-methods-use-this
            stop() {}
        },
    };
});

// FIM's 2025 default X-Air scene, as read over OSC.
function fimMixer() {
    return new Map<string, string | number>([
        ['/ch/01/config/name', 'Wireless RED'],
        ['/ch/02/config/name', 'Wireless Blu'],
        ['/ch/03/config/name', 'DJ L'],
        ['/ch/04/config/name', 'DJ R'],
        ['/rtn/aux/config/name', 'vMix PC'],
        ['/bus/1/config/name', 'Live Stream'],
        ['/ch/03/mix/on', 1],
        ['/ch/03/mix/fader', 0.75],
        ['/ch/03/mix/lr', 1],
        ['/ch/03/mix/01/level', 0],
        ['/ch/04/mix/on', 1],
        ['/ch/04/mix/fader', 0.75],
        ['/ch/04/mix/lr', 1],
        ['/ch/04/mix/01/level', 0],
        ['/rtn/aux/mix/on', 1],
        ['/rtn/aux/mix/fader', 0.75],
        ['/rtn/aux/mix/lr', 1],
        ['/rtn/aux/mix/01/level', 0.75],
    ]);
}

function fimVmix(over: Record<string, unknown> = {}) {
    return {
        streaming: 'True',
        recording: 'True',
        inputs: {
            input: [
                {
                    number: 1,
                    title: 'FMS',
                    muted: 'False',
                    audiobusses: 'M',
                    meterF1: 0,
                },
                {
                    number: 2,
                    title: 'Live Captions',
                    muted: 'True',
                    audiobusses: 'M',
                },
            ],
        },
        overlays: { overlay: [{ number: 1 }, { number: 8, '#text': 2 }] },
        audio: { busA: { muted: 'False', meterF1: 0.3, meterF2: 0.3 } },
        ...over,
    };
}

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
let checks: any;
const get = (id: string): CheckResult =>
    checks.list().find((c: CheckResult) => c.id === id);

async function tick(seconds: number) {
    const target = Date.now() + seconds * 1000;
    while (Date.now() < target) {
        jest.setSystemTime(Math.min(target, Date.now() + 1000));
        // eslint-disable-next-line no-await-in-loop
        await checks.tick();
    }
}

beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    vmix = fimVmix();
    match = null;
    bandwidth = {
        supported: true,
        streams: [{ index: 1, liveKbps: 6000, targetKbps: 6000, speed: 1 }],
    };
    mixer = fimMixer();
    captionsRunning = true;
    matches = [];
    Object.keys(store).forEach((k) => delete store[k]);
    checks = new (Checks as any)();
    // Results exist from start(); start() itself would loop forever.
    checks.results = new Map();
    checks.list = Checks.prototype.list.bind(checks);
    [
        'stream-match',
        'stream-health',
        'recording-match',
        'stream-audio',
        'stream-loudness',
        'dj-stream',
        'match-sounds',
        'match-buzzer',
        'mic-balance',
        'captions',
    ].forEach((id) =>
        checks.results.set(id, {
            id,
            group: 'Stream',
            label: id,
            state: 'unknown',
            detail: '',
            ignoredUntil: null,
        })
    );
});

afterEach(() => jest.useRealTimers());

describe('stream checks', () => {
    it('all good at an FIM-default cart', async () => {
        const v = fimVmix();
        // The match start sound on the FMS input.
        (v.inputs.input[0] as any).meterF1 = 0.5;
        vmix = v;
        match = { label: 'Q14', level: 'Qualification' };
        await tick(6);
        const bad = checks
            .list()
            .filter(
                (c: CheckResult) =>
                    c.state === 'warning' || c.state === 'critical'
            );
        expect(bad).toEqual([]);
    });

    it('a qual running without the stream, after 5 s', async () => {
        vmix = fimVmix({ streaming: 'False' });
        match = { label: 'Q14', level: 'Qualification' };
        await tick(3);
        expect(get('stream-match').state).toBe('ok');
        await tick(4);
        expect(get('stream-match')).toMatchObject({
            state: 'critical',
            detail: 'Q14 running, not streaming',
        });
    });

    it('a stalled stream, after 20 s', async () => {
        bandwidth = { supported: true, streams: [] };
        await tick(10);
        expect(get('stream-health').state).toBe('ok');
        await tick(15);
        expect(get('stream-health').state).toBe('critical');
    });

    it('low bitrate is fine (VBR); under real time is a stall', async () => {
        bandwidth = {
            supported: true,
            streams: [{ index: 1, liveKbps: 300, targetKbps: 6000, speed: 1 }],
        };
        await tick(25);
        expect(get('stream-health').state).toBe('ok');
        bandwidth = {
            supported: true,
            streams: [
                { index: 1, liveKbps: 2000, targetKbps: 6000, speed: 0.62 },
            ],
        };
        await tick(25);
        expect(get('stream-health')).toMatchObject({
            state: 'critical',
            detail: 'Stalled: 0.62x real time',
        });
    });

    it('a quiet stream during a match is not an alarm', async () => {
        const v = fimVmix();
        (v.inputs.input[0] as any).meterF1 = 0.5;
        vmix = v;
        match = { label: 'Q14', level: 'Qualification' };
        // The start sound reaches Bus A, then nobody talks for a minute.
        await tick(5);
        const quiet = fimVmix({
            audio: { busA: { muted: 'False', meterF1: 0, meterF2: 0 } },
        });
        vmix = quiet;
        await tick(60);
        expect(get('stream-audio').state).toBe('ok');
    });

    it('start sound on the FMS input but not on Bus A', async () => {
        await tick(1);
        const v = fimVmix({
            audio: { busA: { muted: 'False', meterF1: 0, meterF2: 0 } },
        });
        (v.inputs.input[0] as any).meterF1 = 0.5;
        vmix = v;
        match = { label: 'Q16', level: 'Qualification' };
        await tick(6);
        expect(get('stream-audio')).toMatchObject({
            state: 'critical',
            detail: 'No Q16 start sound on Bus A',
        });
    });

    it('DJ sent to the Live Stream bus', async () => {
        mixer.set('/ch/03/mix/01/level', 0.6);
        await tick(1);
        expect(get('dj-stream')).toMatchObject({
            state: 'critical',
            detail: 'DJ L sent to Live Stream: -6 dB',
        });
    });

    it('match sounds out of the venue are critical, off the stream a warning', async () => {
        mixer.set('/rtn/aux/mix/lr', 0);
        await tick(1);
        expect(get('match-sounds')).toMatchObject({
            state: 'critical',
            detail: 'vMix PC not in the venue mix on X-Air',
        });
        checks.mixer = null;
        mixer = fimMixer();
        mixer.set('/rtn/aux/mix/01/level', 0);
        await tick(11);
        expect(get('match-sounds')).toMatchObject({
            state: 'warning',
            detail: 'vMix PC not sent to Live Stream',
        });
    });

    it('FMS input muted in vMix', async () => {
        const v = fimVmix();
        v.inputs.input[0].muted = 'True';
        vmix = v;
        await tick(1);
        expect(get('match-sounds')).toMatchObject({
            state: 'critical',
            detail: 'FMS muted in vMix',
        });
    });

    it('captions overlay off while streaming', async () => {
        vmix = fimVmix({ overlays: { overlay: [{ number: 1 }] } });
        await tick(1);
        expect(get('captions')).toMatchObject({
            state: 'warning',
            detail: 'Live Captions not on an overlay',
        });
    });

    it('loudness out of range on the last match', async () => {
        matches = [
            {
                level: 'Qualification',
                matchNumber: 14,
                loudness: { lufs: -24.3, truePeak: -3 },
            },
        ];
        await tick(1);
        expect(get('stream-loudness')).toMatchObject({
            state: 'warning',
            detail: 'Qualification 14: -24.3 LUFS, peak -3.0 dBTP',
        });
    });

    it('no sound at match start', async () => {
        match = { label: 'Q15', level: 'Qualification' };
        await tick(5);
        expect(get('match-buzzer')).toMatchObject({
            state: 'warning',
            detail: 'No sound at Q15 start',
        });
    });

    it('Ignore 6 h stops alerting, then lapses', async () => {
        vmix = fimVmix({ streaming: 'False' });
        match = { label: 'Q14', level: 'Qualification' };
        const alerts: string[] = [];
        checks.on('alert', (r: CheckResult) => alerts.push(r.id));
        await tick(7);
        expect(alerts).toContain('stream-match');
        checks.ignore('stream-match');
        expect(get('stream-match').ignoredUntil).toBe(
            Date.now() + 6 * 3600 * 1000
        );
        jest.setSystemTime(Date.now() + 6 * 3600 * 1000 + 1000);
        await tick(1);
        expect(get('stream-match').ignoredUntil).toBeNull();
    });
});

describe('X-Air OSC', () => {
    it('decodes int, float and string replies', () => {
        const msg = (addr: string, tag: string, arg: Buffer) => {
            const pad = (b: Buffer) =>
                Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
            return Buffer.concat([
                pad(Buffer.from(addr)),
                pad(Buffer.from(tag)),
                arg,
            ]);
        };
        const i = Buffer.alloc(4);
        i.writeInt32BE(1);
        expect(decodeReply(msg('/ch/03/mix/on', ',i', i))).toEqual({
            address: '/ch/03/mix/on',
            value: 1,
        });
        const f = Buffer.alloc(4);
        f.writeFloatBE(0.75);
        expect(
            decodeReply(msg('/ch/03/mix/fader', ',f', f))?.value
        ).toBeCloseTo(0.75);
        const s = Buffer.concat([Buffer.from('DJ L'), Buffer.alloc(4)]);
        expect(decodeReply(msg('/ch/03/config/name', ',s', s))?.value).toBe(
            'DJ L'
        );
    });

    it('converts levels with the X-Air fader law', () => {
        expect(levelToDb(0.75)).toBe(0);
        expect(levelToDb(0.5)).toBe(-10);
        expect(levelToDb(0)).toBe(-Infinity);
    });
});
