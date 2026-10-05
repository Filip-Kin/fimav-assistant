import fs from 'fs';
import os from 'os';
import path from 'path';
import FtcRecorder from '../main/ftc/recorder';
import { assembleClips, waitForFinishedVideo } from '../main/cutMatch';
import { listMatches } from '../main/recordings/matchStore';
import { FtcUpdate } from '../models/Ftc';

// vMix: one recording at a time; each start makes a new file.
let vmixRecording = false;
let vmixFile = 0;
let vmixDir = '';
jest.mock('../services/VmixService', () => ({
    __esModule: true,
    default: {
        Instance: {
            StartRecording: jest.fn(async () => {
                if (!vmixRecording) {
                    vmixFile += 1;
                    fs.writeFileSync(
                        path.join(vmixDir, `capture${vmixFile}.mp4`),
                        'x'
                    );
                }
                vmixRecording = true;
            }),
            StopRecording: jest.fn(async () => {
                vmixRecording = false;
            }),
            GetCurrentRecording: jest.fn(async () =>
                path.join(vmixDir, `capture${vmixFile}.mp4`)
            ),
        },
    },
}));
jest.mock('../main/cutMatch', () => ({
    assembleClips: jest.fn(async (_p: unknown, out: string) =>
        fs.writeFileSync(out, 'video')
    ),
    enqueueCut: jest.fn((task: () => Promise<void>) => task()),
    probeDuration: jest.fn(async () => 100),
    waitForFinishedVideo: jest.fn(async () => true),
    moveVideo: jest.fn(async (a: string, b: string) => fs.renameSync(a, b)),
}));
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d: unknown) =>
            ({ 'ftc.matchSeconds': 158, 'ftc.tailSeconds': 5 }[k] ?? d),
    }),
}));
jest.mock('../utils/recording', () => ({
    matchFileName: (_e: unknown, m: { ShortName: string }) =>
        `2026 Test - ${m.ShortName}.mp4`,
}));
jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
let folder = '';
let recorder: FtcRecorder;
const logs: string[] = [];

const upd = (type: FtcUpdate['type'], shortName: string, field = 1) =>
    recorder.onUpdate({
        type,
        time: Date.now(),
        number: parseInt(shortName.slice(1), 10),
        shortName,
        field,
    });

// Move the clock in small steps so every timer and promise chain settles.
async function at(seconds: number) {
    const target = T0 + seconds * 1000;
    while (Date.now() < target) {
        jest.advanceTimersByTime(Math.min(500, target - Date.now()));
        // eslint-disable-next-line no-await-in-loop
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    for (let i = 0; i < 50; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

const pieces = () =>
    (assembleClips as jest.Mock).mock.calls.map(([p, out]) => ({
        out: path.basename(out),
        p: p.map((x: { file: string; from: number; seconds: number }) => [
            path.basename(x.file),
            Math.round(x.from),
            Math.round(x.seconds),
        ]),
    }));

beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ftcrec-'));
    vmixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmix-'));
    vmixRecording = false;
    vmixFile = 0;
    logs.length = 0;
    (assembleClips as jest.Mock).mockClear();
    recorder = new FtcRecorder({
        event: () => null,
        folder: () => folder,
        log: (m) => logs.push(m),
        setRecording: () => undefined,
        record: () => undefined,
    });
});

afterEach(() => jest.useRealTimers());

describe('FTC recorder', () => {
    it('scores posted before the next match: play + reveal from one file', async () => {
        upd('MATCH_START', 'Q1');
        await at(1);
        expect(vmixRecording).toBe(true);
        await at(200);
        expect(vmixRecording).toBe(true); // waiting for scores
        upd('MATCH_POST', 'Q1');
        await at(215);
        expect(vmixRecording).toBe(true); // reveal still showing
        await at(217);
        expect(vmixRecording).toBe(false);
        expect(pieces()).toEqual([
            {
                out: '2026 Test - Q1.mp4',
                p: [
                    ['raw capture1.mp4', 0, 163],
                    ['raw capture1.mp4', 199, 17],
                ],
            },
        ]);
        const rec = listMatches(folder)[0];
        expect(rec.processing?.state).toBe('done');
        expect(rec.fileName).toBe('2026 Test - Q1.mp4');
    });

    it('next match starts first: one file runs on, late reveal joins Q1', async () => {
        upd('MATCH_START', 'Q1', 1);
        await at(180);
        upd('MATCH_START', 'Q2', 2); // Q1 scores not posted yet
        await at(190);
        upd('MATCH_POST', 'Q1', 1); // during Q2's match
        await at(400);
        expect(vmixRecording).toBe(true); // Q2 waiting for scores
        expect(
            listMatches(folder).find((m) => m.ftc?.shortName === 'Q1')
                ?.processing?.state
        ).toBe('queued'); // held: footage still open
        upd('MATCH_POST', 'Q2', 2);
        await at(420);
        expect(vmixRecording).toBe(false);
        expect(vmixFile).toBe(1); // never stopped between
        expect(pieces()).toEqual([
            {
                out: '2026 Test - Q1.mp4',
                p: [
                    ['raw capture1.mp4', 0, 163],
                    ['raw capture1.mp4', 189, 17],
                ],
            },
            {
                out: '2026 Test - Q2.mp4',
                p: [
                    ['raw capture1.mp4', 179, 164],
                    ['raw capture1.mp4', 399, 17],
                ],
            },
        ]);
    });

    it('no scores ever: play only after 10 minutes', async () => {
        upd('MATCH_START', 'Q1');
        await at(163 + 600 - 5);
        expect(vmixRecording).toBe(true);
        await at(163 + 600 + 2);
        expect(vmixRecording).toBe(false);
        expect(pieces()).toEqual([
            {
                out: '2026 Test - Q1.mp4',
                p: [['raw capture1.mp4', 0, 163]],
            },
        ]);
    });

    it('abort: no video, replay is the match', async () => {
        upd('MATCH_START', 'Q1');
        await at(30);
        upd('MATCH_ABORT', 'Q1');
        await at(41);
        expect(vmixRecording).toBe(false);
        expect(listMatches(folder)[0].error).toBe('Aborted');
        upd('MATCH_START', 'Q1');
        await at(250);
        upd('MATCH_POST', 'Q1');
        await at(270);
        expect(pieces()).toEqual([
            {
                out: '2026 Test - Q1.mp4',
                p: [
                    ['raw capture2.mp4', 0, 163],
                    ['raw capture2.mp4', 208, 17],
                ],
            },
        ]);
    });

    it('a second post of the same match is ignored', async () => {
        upd('MATCH_START', 'Q1');
        await at(200);
        upd('MATCH_POST', 'Q1');
        await at(230);
        upd('MATCH_POST', 'Q1');
        await at(260);
        expect(vmixRecording).toBe(false);
        expect(vmixFile).toBe(1);
        expect(pieces()).toHaveLength(1);
    });

    it('a match start is not held up while vMix finishes the last file', async () => {
        (waitForFinishedVideo as jest.Mock).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve(true), 30000);
                })
        );
        upd('MATCH_START', 'Q1');
        await at(170);
        upd('MATCH_POST', 'Q1');
        await at(187); // Q1 stopped; its file takes 30 s to finish
        expect(vmixRecording).toBe(false);
        upd('MATCH_START', 'Q2');
        await at(188);
        expect(vmixRecording).toBe(true);
        expect(pieces()).toHaveLength(0); // Q1 waits for its file
        await at(220);
        expect(pieces()).toEqual([
            {
                out: '2026 Test - Q1.mp4',
                p: [
                    ['raw capture1.mp4', 0, 163],
                    ['raw capture1.mp4', 169, 17],
                ],
            },
        ]);
    });
});
