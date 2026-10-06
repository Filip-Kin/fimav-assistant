import Checks from '../main/checks/engine';
import { decodeReply, levelToDb } from '../main/checks/xair';
import { parseStreamSettings } from '../main/checks/vmixSettings';
import { setCaptionKey } from '../main/checks/captionsYoutube';
import VmixService from '../services/VmixService';
import { CheckResult } from '../models/Checks';

// The world the checks read, set per test.
let vmix: any = null;
let match: { label: string; level: string } | null = null;
let bandwidth: any = { supported: true, streams: [] };
let mixer = new Map<string, string | number>();
let captionsRunning = true;
let matches: any[] = [];
const store: Record<string, unknown> = {};
let settings: any = null;
let hw: any = null;
let hwPingedAt = 0;
let push: any = null;

jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});
jest.mock('../services/VmixService', () => ({
    __esModule: true,
    default: {
        Instance: {
            GetBase: async () => (vmix ? { vmix } : null),
            Function: jest.fn(async () => undefined),
        },
    },
}));
jest.mock('../main/checks/vmixSettings', () => ({
    ...jest.requireActual('../main/checks/vmixSettings'),
    readStreamSettings: () => settings,
}));
jest.mock('../main/checks/captionsYoutube', () => ({
    ...jest.requireActual('../main/checks/captionsYoutube'),
    getCaptionPushStatus: async () => push,
    setCaptionKey: jest.fn(async () => undefined),
    enableCaptionPush: jest.fn(async () => undefined),
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
    default: {
        Instance: {
            mixerAddress: () => '192.168.25.13',
            get currentStatus() {
                return hw;
            },
            get lastPingAt() {
                return hwPingedAt;
            },
        },
    },
}));
jest.mock('../main/vmixBandwidth', () => ({
    __esModule: true,
    streamKeyFromUrl: jest.requireActual('../main/vmixBandwidth')
        .streamKeyFromUrl,
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
                    key: 'fms-key',
                    number: 1,
                    title: 'FMS',
                    muted: 'False',
                    audiobusses: 'M',
                    meterF1: 0,
                },
                {
                    key: 'lc-key',
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
        streams: [
            {
                index: 1,
                liveKbps: 6000,
                targetKbps: 6000,
                speed: 1,
                audioBus: 'Bus A',
                rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh',
            },
        ],
    };
    settings = {
        audioBus: 'Bus A',
        output: 2,
        output2Overlays: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16],
        youtubeKey: 'abcd-efgh',
        recordOutput: 2,
        recordAudioBus: 'Bus A',
    };
    push = {
        enabled: true,
        url: 'http://upload.youtube.com/closedcaption?cid=abcd-efgh',
        running: true,
        lastPushAt: null,
        queueDepth: 0,
        lastError: null,
    };
    (VmixService.Instance.Function as jest.Mock).mockClear();
    (setCaptionKey as jest.Mock).mockClear();
    hw = {
        camera1: true,
        camera2: true,
        mixer: true,
        switch: true,
        internet: true,
        errors: [],
        ip_errors: [],
        ip_warnings: [],
    };
    hwPingedAt = T0;
    mixer = fimMixer();
    captionsRunning = true;
    matches = [];
    Object.keys(store).forEach((k) => delete store[k]);
    checks = new (Checks as any)();
    // Results exist from start(); start() itself would loop forever.
    checks.results = new Map();
    checks.list = Checks.prototype.list.bind(checks);
    [
        'hw-network',
        'hw-ip',
        'hw-switch',
        'hw-mixer',
        'hw-camera1',
        'hw-camera2',
        'stream-match',
        'stream-health',
        'stream-bus',
        'stream-output',
        'recording-match',
        'recording-bus',
        'stream-audio',
        'stream-loudness',
        'dj-stream',
        'match-sounds',
        'match-buzzer',
        'mic-balance',
        'captions',
        'captions-youtube',
    ].forEach((id) =>
        checks.results.set(id, {
            id,
            group: id.startsWith('hw-') ? 'Hardware' : 'Stream',
            label: id,
            state: 'unknown',
            detail: '',
            ignoredUntil: null,
            fix: null,
            doc: null,
            hint: null,
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

    it('no Bus A in vMix is critical', async () => {
        vmix = fimVmix({ audio: { master: { muted: 'False' } } });
        await tick(1);
        expect(get('stream-audio')).toMatchObject({
            state: 'critical',
            detail: 'No Bus A in vMix audio mixer',
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

    it('FMS muted: Unmute sends AudioOn for that input', async () => {
        const v = fimVmix();
        v.inputs.input[0].muted = 'True';
        vmix = v;
        await tick(1);
        expect(get('match-sounds').fix).toBe('Unmute');
        (VmixService.Instance.Function as jest.Mock).mockImplementationOnce(
            async () => {
                v.inputs.input[0].muted = 'False';
            }
        );
        await checks.fix('match-sounds');
        expect(VmixService.Instance.Function).toHaveBeenCalledWith('AudioOn', {
            Input: 'fms-key',
        });
        // Checked again straight after the fix: the button is gone.
        expect(get('match-sounds')).toMatchObject({ state: 'ok', fix: null });
    });

    it('an input titled "Audience" is the display input', async () => {
        const v = fimVmix();
        v.inputs.input[0].title = 'Audience';
        v.inputs.input[0].muted = 'True';
        vmix = v;
        await tick(1);
        expect(get('match-sounds').detail).toBe('Audience muted in vMix');
    });

    it('captions on another overlay: fix puts them on overlay 8', async () => {
        vmix = fimVmix({
            overlays: { overlay: [{ number: 3, '#text': 2 }, { number: 8 }] },
        });
        await tick(1);
        expect(get('captions')).toMatchObject({
            state: 'warning',
            detail: 'Live Captions not on overlay 8',
            fix: 'Put on overlay 8',
        });
        await checks.fix('captions');
        expect(VmixService.Instance.Function).toHaveBeenCalledWith(
            'OverlayInput8In',
            { Input: 'lc-key' }
        );
        vmix = fimVmix();
        await tick(1);
        expect(get('captions')).toMatchObject({ state: 'ok', fix: null });
    });

    it('a live stream on Master is critical', async () => {
        bandwidth.streams[0].audioBus = 'Master';
        await tick(1);
        expect(get('stream-bus')).toMatchObject({
            state: 'critical',
            detail: 'Stream 1 on Master, not Bus A',
        });
    });

    it('stream settings on Master before going live are critical', async () => {
        vmix = fimVmix({ streaming: 'False' });
        settings.audioBus = 'Master';
        await tick(1);
        expect(get('stream-bus')).toMatchObject({
            state: 'critical',
            detail: 'Stream settings on Master, not Bus A',
        });
    });

    it('live on Bus A, settings changed to Master: a warning', async () => {
        settings.audioBus = 'Master';
        await tick(1);
        expect(get('stream-bus')).toMatchObject({
            state: 'warning',
            detail: 'Stream settings on Master, not Bus A',
        });
    });

    it('stream on Output 1 or overlay 8 on Output 2: a warning', async () => {
        settings.output = 1;
        await tick(1);
        expect(get('stream-output')).toMatchObject({
            state: 'warning',
            detail: 'Stream on Output 1, not Output 2',
        });
        settings.output = 2;
        settings.recordOutput = 1;
        await tick(1);
        expect(get('stream-output')).toMatchObject({
            state: 'warning',
            detail: 'Recorder 1 on Output 1, not Output 2',
        });
        settings.recordOutput = 2;
        settings.output2Overlays = [1, 8];
        await tick(1);
        expect(get('stream-output')).toMatchObject({
            state: 'warning',
            detail: 'Overlay 8 (captions) on Output 2',
        });
    });

    it('vMix closed: no verdict from its saved settings', async () => {
        vmix = null;
        settings.output = 1;
        settings.recordAudioBus = 'Master';
        push.url = 'http://upload.youtube.com/closedcaption?cid=old-key';
        await tick(1);
        ['stream-output', 'recording-bus'].forEach((id) =>
            expect(get(id)).toMatchObject({
                state: 'unknown',
                detail: 'vMix not answering',
            })
        );
        // No stream key to compare with, so not a mismatch.
        expect(get('captions-youtube').state).toBe('ok');
    });

    it('nothing to measure is Not checked, not OK', async () => {
        vmix = fimVmix({ streaming: 'False' });
        await tick(1);
        expect(get('stream-health')).toMatchObject({
            state: 'unknown',
            detail: 'Not streaming',
        });
        expect(get('stream-audio')).toMatchObject({
            state: 'unknown',
            detail: 'Not streaming',
        });
        expect(get('stream-loudness')).toMatchObject({
            state: 'unknown',
            detail: 'No measurement yet',
        });
        // Bus A muted before going live: a warning, with the fix.
        vmix = fimVmix({
            streaming: 'False',
            audio: { busA: { muted: 'True', meterF1: 0, meterF2: 0 } },
        });
        await tick(1);
        expect(get('stream-audio')).toMatchObject({
            state: 'warning',
            detail: 'Bus A muted',
            fix: 'Unmute',
        });
    });

    it('recorder 1 on Master is a warning', async () => {
        settings.recordAudioBus = 'Master';
        await tick(1);
        expect(get('recording-bus')).toMatchObject({
            state: 'warning',
            detail: 'Recorder 1 on Master, not Bus A',
        });
    });

    it('caption key not the stream key: Set key uses the stream key', async () => {
        push.url = 'http://upload.youtube.com/closedcaption?cid=old-key';
        await tick(1);
        expect(get('captions-youtube')).toMatchObject({
            state: 'warning',
            detail: 'Caption key not the stream key',
            fix: 'Set key',
        });
        await checks.fix('captions-youtube');
        expect(setCaptionKey).toHaveBeenCalledWith('abcd-efgh');
    });

    it('no caption key in Live Captions', async () => {
        push.url = null;
        await tick(1);
        expect(get('captions-youtube')).toMatchObject({
            state: 'warning',
            detail: 'No YouTube caption key',
        });
    });

    it('hardware from the status bar pings, list only', async () => {
        const alerts: string[] = [];
        checks.on('alert', (r: CheckResult) => alerts.push(r.id));
        hwPingedAt = 0;
        await tick(1);
        expect(get('hw-camera2')).toMatchObject({
            state: 'unknown',
            detail: 'Not pinged yet',
        });
        hwPingedAt = T0;
        hw.camera2 = false;
        hw.internet = false;
        hw.ip_errors = [
            'AV VLAN has a self-assigned IP (169.254.3.4). Check cable or static IP config.',
            'AV VLAN is disconnected or not found.',
        ];
        await tick(1);
        expect(get('hw-camera2')).toMatchObject({
            state: 'warning',
            detail: 'No reply',
        });
        expect(get('hw-network').state).toBe('critical');
        expect(get('hw-ip')).toMatchObject({
            state: 'critical',
            detail: 'AV VLAN has a self-assigned IP (169.254.3.4) (+1)',
        });
        expect(alerts).toEqual([]);
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

    it('Ignore stops alerting for 6 h, then lapses', async () => {
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

describe('vMix autosave', () => {
    const dest = (url: string, key: string) =>
        `&lt;Stream&gt;${key}&lt;/Stream&gt;&lt;URL&gt;${url}&lt;/URL&gt;`;
    const xml = `<XML><StreamingSettings SelectedIndex="1">
<StreamingSetting><AudioChannel>0</AudioChannel><Source>0</Source></StreamingSetting>
<StreamingSetting><Destination0>${dest(
        'rtmp://a.rtmp.youtube.com/live2',
        'yt-key'
    )}</Destination0><AudioChannel>10</AudioChannel><AudioChannel1>0</AudioChannel1><Source>1</Source></StreamingSetting>
</StreamingSettings>
<RecordingSettings><AudioChannel>10</AudioChannel><Channel>1</Channel></RecordingSettings>
<RecordingSettings2><Channel>0</Channel></RecordingSettings2>
<OutputsExternal><Overlay7>1</Overlay7></OutputsExternal>
<OutputsExternal2><Overlay0>1</Overlay0><Overlay7>0</Overlay7></OutputsExternal2></XML>`;

    it('reads the selected stream profile and Output 2 overlays', () => {
        expect(parseStreamSettings(xml)).toEqual({
            audioBus: 'Bus A',
            output: 2,
            output2Overlays: [1],
            youtubeKey: 'yt-key',
            recordOutput: 2,
            recordAudioBus: 'Bus A',
        });
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
