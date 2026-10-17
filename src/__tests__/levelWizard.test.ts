import { EventEmitter } from 'events';
import LevelWizard from '../main/checks/levelWizard';
import { dbToLevel, FADER_STEPS, levelToDb } from '../utils/xairLaw';
import { LevelState } from '../models/Levels';

// The wizard against a fake X-Air (a parameter map), fake meters and a fake
// vMix. FIM's default scene: ch 1 Wireless RED, ch 2 Wireless Blu, ch 3/4
// DJ L/R, aux return "vMix PC" (match sounds), Bus 1 "Live Stream".

const mixer = new Map<string, number>();
const writes: { address: string; value: number }[] = [];
let busA = 80;
let matchNow: { label: string; level: string } | null = null;

const checks = Object.assign(new EventEmitter(), {
    mixerState: () => ({
        at: 0,
        reachable: true,
        streamBus: 1,
        streamBusName: 'Live Stream',
        streamBusFaderDb: levelToDb(mixer.get('/bus/1/mix/fader') ?? 0),
        lrFaderDb: 0,
        mics: [
            { name: 'Wireless RED', path: '/ch/01', meter: 0, streamTap: 3 },
            { name: 'Wireless Blu', path: '/ch/02', meter: 1, streamTap: 3 },
        ],
        game: [
            {
                name: 'vMix PC',
                path: '/rtn/aux',
                meter: 16,
                stereo: true,
                streamTap: 3,
            },
        ],
        dj: [
            { name: 'DJ L', path: '/ch/03', meter: 2, streamTap: 3 },
            { name: 'DJ R', path: '/ch/04', meter: 3, streamTap: 3 },
        ],
    }),
    wantMeters: jest.fn(),
    refresh: jest.fn(async () => undefined),
});

jest.mock('electron-log', () => ({
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
}));
jest.mock('../main/checks/engine', () => ({
    __esModule: true,
    default: {
        get Instance() {
            return checks;
        },
    },
}));
jest.mock('../main/addons/autoav', () => ({
    __esModule: true,
    default: {
        Instance: {
            on: jest.fn(),
            off: jest.fn(),
            matchInPlay: () => matchNow,
            getStatus: () => ({ saveFolder: null }),
        },
    },
}));
jest.mock('../main/addons/hw-ping', () => ({
    __esModule: true,
    default: { Instance: { mixerAddress: () => '192.168.25.13' } },
}));
jest.mock('../services/VmixService', () => ({
    __esModule: true,
    default: {
        Instance: {
            GetBase: async () => ({
                vmix: { audio: { busA: { volume: String(busA) } } },
            }),
            Function: jest.fn(async (fn: string, p: { Value: string }) => {
                if (fn === 'SetBusAVolume') busA = Number(p.Value);
            }),
        },
    },
}));
jest.mock('../main/recordings/matchStore', () => ({
    listMatches: () => [],
    updateMatch: jest.fn(),
}));
jest.mock('../main/checks/liveLoudness', () => ({
    __esModule: true,
    default: class {
        public running = false;

        public failed: string | null = 'Not Windows';

        public lastAt = 0;

        public onBlock = null;

        start() {
            this.running = false;
        }

        // eslint-disable-next-line class-methods-use-this
        stop() {}
    },
}));
jest.mock('../main/checks/xair', () => {
    const actual = jest.requireActual('../main/checks/xair');
    const answer = (addrs: string[]) =>
        new Map(
            addrs.filter((a) => mixer.has(a)).map((a) => [a, mixer.get(a)!])
        );
    return {
        ...actual,
        queryXair: async (_h: string, addrs: string[]) => answer(addrs),
        writeXair: async (
            _h: string,
            ws: { address: string; value: number }[]
        ) => {
            ws.forEach((w) => {
                writes.push(w);
                mixer.set(w.address, w.value);
            });
        },
        setXair: async (
            _h: string,
            ws: { address: string; value: number }[]
        ) => {
            ws.forEach((w) => {
                writes.push(w);
                mixer.set(w.address, w.value);
            });
            return answer(ws.map((w) => w.address));
        },
    };
});

const f = (db: number) => dbToLevel(db, FADER_STEPS);

function fimScene() {
    mixer.clear();
    [
        ['/lr/mix/fader', f(-5)],
        ['/bus/1/mix/fader', f(0)],
        ['/ch/01/mix/fader', f(-8)],
        ['/ch/01/mix/01/level', f(0)],
        ['/ch/01/config/insrc', 0],
        ['/headamp/01/gain', 0.5],
        ['/ch/02/mix/fader', f(-8)],
        ['/ch/02/mix/01/level', f(0)],
        ['/ch/02/config/insrc', 1],
        ['/headamp/02/gain', 0.5],
        ['/rtn/aux/mix/fader', f(0)],
        ['/rtn/aux/mix/01/level', f(0)],
        // Bus 1 send taps: red PRE, blue GRP, match sounds POST.
        ['/ch/01/mix/01/tap', 3],
        ['/ch/02/mix/01/tap', 5],
        ['/rtn/aux/mix/01/tap', 4],
        // DJ sent to the stream: the wizard must take it off.
        ['/ch/03/mix/fader', f(0)],
        ['/ch/03/mix/01/level', f(-6)],
        ['/ch/03/mix/01/grpon', 0],
        ['/ch/04/mix/fader', f(0)],
        ['/ch/04/mix/01/level', 0],
        ['/ch/04/mix/01/grpon', 0],
    ].forEach(([a, v]) => mixer.set(a as string, v as number));
}

let now = 1_000_000;

// `seconds` of meter packets every 50 ms with `level` dBFS on one meter
// index (others silent).
function sound(indexes: number[], level: number, seconds: number) {
    for (let k = 0; k < seconds * 20; k += 1) {
        now += 50;
        const levels = Array(40).fill(-90);
        indexes.forEach((i) => {
            levels[i] = level + (k % 2 ? -3 : 0);
        });
        checks.emit('meters', levels, now);
    }
}

const state = () => LevelWizard.Instance.state() as LevelState;

describe('level wizard', () => {
    beforeEach(() => {
        fimScene();
        writes.length = 0;
        busA = 80;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(async () => {
        await LevelWizard.Instance.close(false);
        jest.restoreAllMocks();
    });

    it('red mic: gain +20, fader 0, Master down to -50, Master on the fader', async () => {
        await LevelWizard.Instance.start();
        expect(mixer.get('/headamp/01/gain')).toBe(64 / 144);
        expect(levelToDb(mixer.get('/ch/01/mix/fader')!)).toBeCloseTo(0, 1);
        expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(-50, 1);
        const w = state().wizard!;
        expect(w.step).toBe('red');
        expect(w.faderTarget).toBe('Master');
        expect(w.fader).toBeCloseTo(-50, 1);
        // Talking: listening, then done after 5 s.
        sound([0], -20, 2);
        expect(state().wizard!.rows[0].status).toBe('listening');
        sound([0], -20, 4);
        expect(state().wizard!.rows[0].status).toBe('done');
        expect(state().wizard!.rows[0].input).toBeCloseTo(-21.2, 0);
    });

    it('no signal when the mic stays quiet', async () => {
        await LevelWizard.Instance.start();
        sound([], -90, 9);
        expect(state().wizard!.rows[0].status).toBe('no signal');
    });

    it('the on-screen fader moves Master in the red step, ch 2 in the blue', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
            await LevelWizard.Instance.start();
            LevelWizard.Instance.fader(-20);
            jest.advanceTimersByTime(50);
            await LevelWizard.Instance.faderDone();
            expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(-20, 1);
            await LevelWizard.Instance.go('blue');
            expect(state().wizard!.faderTarget).toBe('Blue mic');
            expect(mixer.get('/headamp/02/gain')).toBe(64 / 144);
            LevelWizard.Instance.fader(-4);
            jest.advanceTimersByTime(50);
            await LevelWizard.Instance.faderDone();
            expect(levelToDb(mixer.get('/ch/02/mix/fader')!)).toBeCloseTo(
                -4,
                1
            );
            // Master stays where the red step left it.
            expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(-20, 1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('DJ step turns the DJ stream send off and the plan leaves DJ out', async () => {
        await LevelWizard.Instance.start();
        sound([0], -20, 6);
        await LevelWizard.Instance.go('blue');
        sound([1], -26, 6);
        await LevelWizard.Instance.go('match');
        matchNow = { label: 'Test 1', level: 'Test' };
        sound([16, 17], -14, 4);
        matchNow = null;
        await LevelWizard.Instance.go('dj');
        expect(mixer.get('/ch/03/mix/01/level')).toBe(0);
        expect(state().wizard!.djSendOff).toBe(true);
        sound([2, 3], -12, 6);
        await LevelWizard.Instance.go('stream');
        const w = state().wizard!;
        expect(w.plan).not.toBeNull();
        expect(w.plan!.lufs).toBeCloseTo(-14, 0);
        const rows = w.rows.filter((r) => r.id !== 'dj');
        // Equal on Bus 1 (0.25 dB send steps).
        rows.forEach((r) => expect(r.bus).toBeCloseTo(rows[0].bus!, 0));
        writes.length = 0;
        await LevelWizard.Instance.apply();
        // Sends and the Bus 1 master; never a DJ send above off.
        expect(writes.map((x) => x.address)).toEqual(
            expect.arrayContaining([
                '/ch/01/mix/01/level',
                '/ch/02/mix/01/level',
                '/rtn/aux/mix/01/level',
                '/bus/1/mix/fader',
            ])
        );
        expect(
            writes.filter(
                (x) =>
                    /\/ch\/0[34]\/mix\/01\/level/.test(x.address) && x.value > 0
            )
        ).toEqual([]);
        expect(busA).toBe(100);
        expect(state().wizard!.step).toBe('check');
    });

    it('undo steps back; cancel puts back everything it changed', async () => {
        await LevelWizard.Instance.start();
        await LevelWizard.Instance.go('blue');
        await LevelWizard.Instance.undoLast();
        expect(mixer.get('/headamp/02/gain')).toBe(0.5);
        expect(levelToDb(mixer.get('/ch/02/mix/fader')!)).toBeCloseTo(-8, 1);
        // The red step's changes still stand.
        expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(-50, 1);
        await LevelWizard.Instance.go('dj');
        await LevelWizard.Instance.close(true);
        expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(-5, 1);
        expect(mixer.get('/headamp/01/gain')).toBe(0.5);
        expect(levelToDb(mixer.get('/ch/01/mix/fader')!)).toBeCloseTo(-8, 1);
        // Except a DJ send to the stream: that stays off.
        expect(mixer.get('/ch/03/mix/01/level')).toBe(0);
        expect(state().wizard).toBeNull();
    });

    // Master is the operator's: no automatic path may write it.
    describe('Master (LR) is never automatic', () => {
        const lrWrites = () =>
            writes.filter((x) => x.address === '/lr/mix/fader');

        const measureAll = async () => {
            await LevelWizard.Instance.start();
            sound([0], -20, 6);
            await LevelWizard.Instance.go('blue');
            sound([1], -26, 6);
            await LevelWizard.Instance.go('match');
            sound([16, 17], -14, 4);
            await LevelWizard.Instance.go('dj');
            sound([2, 3], -12, 6);
        };

        it('Apply, Stream level and the plan do not write or read it', async () => {
            await measureAll();
            // The operator sets Master somewhere odd for the venue.
            mixer.set('/lr/mix/fader', f(-72));
            await LevelWizard.Instance.go('stream');
            const plan1 = state().wizard!.plan;
            // The stream plan does not depend on where Master is.
            mixer.set('/lr/mix/fader', f(5));
            (LevelWizard.Instance as any).values.set('/lr/mix/fader', f(5));
            await LevelWizard.Instance.go('stream');
            expect(state().wizard!.plan).toEqual(plan1);
            mixer.set('/lr/mix/fader', f(-72));
            (LevelWizard.Instance as any).values.set('/lr/mix/fader', f(-72));
            writes.length = 0;
            await LevelWizard.Instance.apply();
            // Someone talks on the stream at -30 LUFS: Stream level.
            const { live } = LevelWizard.Instance as any;
            for (let k = 0; k < 40; k += 1) {
                sound([0], -20, 0.1);
                live.onBlock({ at: now, m: -30, peak: -25 });
            }
            expect(state().wizard!.verify.residual).toBe(16);
            await LevelWizard.Instance.streamLevel();
            expect(lrWrites()).toEqual([]);
            expect(mixer.get('/lr/mix/fader')).toBe(f(-72));
        });

        it('the residual is applied whole, no 10 dB cap', async () => {
            await measureAll();
            await LevelWizard.Instance.go('stream');
            await LevelWizard.Instance.apply();
            const bus = levelToDb(mixer.get('/bus/1/mix/fader')!);
            const { live } = LevelWizard.Instance as any;
            for (let k = 0; k < 40; k += 1) {
                sound([0], -20, 0.1);
                live.onBlock({ at: now, m: -40, peak: -40 });
            }
            expect(state().wizard!.verify.residual).toBe(26);
            await LevelWizard.Instance.streamLevel();
            // +26 dB asked; the fader stops at its +10 dB.
            expect(levelToDb(mixer.get('/bus/1/mix/fader')!)).toBeCloseTo(
                Math.min(10, bus + 26),
                1
            );
        });

        it('an automatic write of Master is refused', async () => {
            await LevelWizard.Instance.start();
            writes.length = 0;
            await expect(
                (LevelWizard.Instance as any).write('Stream mix', [
                    { address: '/lr/mix/fader', value: 1 },
                ])
            ).rejects.toThrow('Master is not automatic');
            await expect(
                (LevelWizard.Instance as any).send('192.168.25.13', [
                    { address: '/lr/mix/fader', value: 1 },
                ])
            ).rejects.toThrow('Master is not automatic');
            expect(lrWrites()).toEqual([]);
        });

        it('allowed: the -50 dB start, the operator fader down to off, undo', async () => {
            jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
            try {
                await LevelWizard.Instance.start();
                expect(
                    lrWrites().map((x) => levelToDb(x.value))[0]
                ).toBeCloseTo(-50, 1);
                LevelWizard.Instance.fader(-Infinity);
                jest.advanceTimersByTime(50);
                await LevelWizard.Instance.faderDone();
                expect(mixer.get('/lr/mix/fader')).toBe(0);
                LevelWizard.Instance.fader(-85);
                jest.advanceTimersByTime(50);
                await LevelWizard.Instance.faderDone();
                expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(
                    -85,
                    0
                );
                await LevelWizard.Instance.undoLast();
                expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(
                    -50,
                    1
                );
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it('check step: talking is the mic input, whatever its fader', async () => {
        await LevelWizard.Instance.start();
        await LevelWizard.Instance.go('check');
        mixer.set('/ch/01/mix/fader', 0);
        const { live } = LevelWizard.Instance as any;
        // Nobody talking: stream blocks do not count.
        for (let k = 0; k < 40; k += 1) {
            sound([], -90, 0.1);
            live.onBlock({ at: now + 5000, m: -14, peak: -10 });
        }
        expect(state().wizard!.verify.seconds).toBe(0);
        expect(state().wizard!.verify.residual).toBeNull();
        // Talking into a mic whose fader is down: counts.
        for (let k = 0; k < 40; k += 1) {
            sound([0], -20, 0.1);
            live.onBlock({ at: now, m: -50, peak: -45 });
        }
        expect(state().wizard!.verify.lufs).toBeCloseTo(-50, 5);
        expect(state().wizard!.verify.residual).toBe(36);
    });

    describe('mic and match-sound sends are post-fader', () => {
        const measureAll = async () => {
            await LevelWizard.Instance.start();
            sound([0], -20, 6);
            await LevelWizard.Instance.go('blue');
            sound([1], -26, 6);
            await LevelWizard.Instance.go('match');
            sound([16, 17], -14, 4);
            await LevelWizard.Instance.go('dj');
            sound([2, 3], -12, 6);
            await LevelWizard.Instance.go('stream');
        };

        it('Apply switches PRE and GRP to POST, shows it, Undo puts them back', async () => {
            await measureAll();
            expect(state().wizard!.toPost).toEqual(['red', 'blue']);
            await LevelWizard.Instance.apply();
            expect(mixer.get('/ch/01/mix/01/tap')).toBe(4);
            expect(mixer.get('/ch/02/mix/01/tap')).toBe(4);
            expect(mixer.get('/rtn/aux/mix/01/tap')).toBe(4);
            expect(state().wizard!.madePost).toEqual(['red', 'blue']);
            expect(state().wizard!.toPost).toEqual([]);
            // DJ sends stay off.
            expect(mixer.get('/ch/03/mix/01/level')).toBe(0);
            await LevelWizard.Instance.undoLast();
            expect(mixer.get('/ch/01/mix/01/tap')).toBe(3);
            expect(mixer.get('/ch/02/mix/01/tap')).toBe(5);
            expect(mixer.get('/ch/03/mix/01/level')).toBe(0);
        });

        it('Cancel puts the old taps back too', async () => {
            await measureAll();
            await LevelWizard.Instance.apply();
            await LevelWizard.Instance.close(true);
            expect(mixer.get('/ch/01/mix/01/tap')).toBe(3);
            expect(mixer.get('/ch/02/mix/01/tap')).toBe(5);
            expect(mixer.get('/ch/03/mix/01/level')).toBe(0);
        });

        it('after Apply, a mic fader moved X dB moves it on Bus 1 by X dB, Master by nothing', async () => {
            await measureAll();
            await LevelWizard.Instance.apply();
            const lr = mixer.get('/lr/mix/fader');
            const before = state().wizard!.rows.find((r) => r.id === 'red')!
                .bus!;
            const fader = levelToDb(mixer.get('/ch/01/mix/fader')!);
            // The operator rides ch 1 down 6 dB for a quieter announcer.
            const moved = f(fader - 6);
            mixer.set('/ch/01/mix/fader', moved);
            (LevelWizard.Instance as any).values.set('/ch/01/mix/fader', moved);
            const after = state().wizard!.rows.find((r) => r.id === 'red')!
                .bus!;
            expect(after - before).toBeCloseTo(levelToDb(moved) - fader, 5);
            expect(after - before).toBeCloseTo(-6, 0);
            // Blue and match sounds on Bus 1 do not move; Master is untouched.
            expect(mixer.get('/lr/mix/fader')).toBe(lr);
            expect(
                writes.filter((x) => x.address === '/lr/mix/fader').length
            ).toBe(1);
        });
    });

    // Changes made on the mixer itself (desk, X-Air Edit), as /xremote
    // pushes them: the engine's 'mixer-param' event.
    describe('following the mixer', () => {
        const desk = (address: string, value: number) => {
            mixer.set(address, value);
            checks.emit('mixer-param', address, value);
        };
        const measureAll = async () => {
            await LevelWizard.Instance.start();
            sound([0], -20, 6);
            await LevelWizard.Instance.go('blue');
            sound([1], -26, 6);
            await LevelWizard.Instance.go('match');
            sound([16, 17], -14, 4);
            await LevelWizard.Instance.go('dj');
            sound([2, 3], -12, 6);
            await LevelWizard.Instance.go('stream');
        };
        const bus = (id: string) =>
            state().wizard!.rows.find((r) => r.id === id)!.bus!;

        it('a desk fader move shows at once and the plan follows it', async () => {
            await measureAll();
            const plan = state().wizard!.plan!;
            const red = bus('red');
            const fader = levelToDb(mixer.get('/ch/01/mix/fader')!);
            desk('/ch/01/mix/fader', f(fader - 6));
            // The plan is worked out again: same stream, red's send 6 dB up
            // to make up for its fader (post-fader send).
            const again = state().wizard!.plan!;
            expect(again.lufs).toBeCloseTo(plan.lufs, 1);
            expect(bus('red')).toBeCloseTo(red, 0);
            // And a Bus 1 master moved on the desk.
            desk('/bus/1/mix/fader', f(-3));
            expect(state().wizard!.plan!.busFrom).toBeCloseTo(-3, 1);
        });

        it('after Apply, a desk move moves the source on Bus 1', async () => {
            await measureAll();
            await LevelWizard.Instance.apply();
            const red = bus('red');
            const fader = levelToDb(mixer.get('/ch/01/mix/fader')!);
            desk('/ch/01/mix/fader', f(fader - 6));
            expect(bus('red') - red).toBeCloseTo(-6, 0);
        });

        it("the mixer's echo of the wizard's own write is not the operator", async () => {
            await LevelWizard.Instance.start();
            // The -50 dB Master preset echoed back by /xremote.
            desk('/lr/mix/fader', mixer.get('/lr/mix/fader')!);
            await LevelWizard.Instance.close(true);
            expect(levelToDb(mixer.get('/lr/mix/fader')!)).toBeCloseTo(-5, 1);
        });

        it('Cancel and Undo leave a value the operator moved on the desk', async () => {
            await LevelWizard.Instance.start();
            await LevelWizard.Instance.go('blue');
            // After the wizard set them, the operator rides Master and ch 2.
            desk('/lr/mix/fader', f(-30));
            desk('/ch/02/mix/fader', f(-12));
            await LevelWizard.Instance.undoLast();
            // The blue step's undo: gain back, ch 2 fader left alone.
            expect(mixer.get('/headamp/02/gain')).toBe(0.5);
            expect(mixer.get('/ch/02/mix/fader')).toBe(f(-12));
            await LevelWizard.Instance.close(true);
            // Cancel: what the wizard still holds goes back...
            expect(mixer.get('/headamp/01/gain')).toBe(0.5);
            expect(levelToDb(mixer.get('/ch/01/mix/fader')!)).toBeCloseTo(
                -8,
                1
            );
            // ...the operator's Master and ch 2 stay.
            expect(mixer.get('/lr/mix/fader')).toBe(f(-30));
            expect(mixer.get('/ch/02/mix/fader')).toBe(f(-12));
        });
    });
});
