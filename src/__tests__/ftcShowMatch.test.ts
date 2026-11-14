import FtcScorekeeper from '../main/addons/ftc-scorekeeper';

jest.mock('os', () => ({ networkInterfaces: () => ({}) }));
jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});
jest.mock('../main/bitfocus', () => ({
    companionUrl: () => 'http://127.0.0.1:8888',
}));
const store: Record<string, unknown> = {
    'ftc.triggers': {
        'SHOW_MATCH:1': { page: 1, row: 0, column: 1 },
        'SHOW_MATCH:2': { page: 1, row: 1, column: 1 },
        'MATCH_START:2': { page: 2, row: 0, column: 0 },
    },
};
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d: unknown) => (k in store ? store[k] : d),
        set: (k: string, v: unknown) => {
            store[k] = v;
        },
    }),
}));
if (!(AbortSignal as any).timeout) {
    (AbortSignal as any).timeout = () => new AbortController().signal;
}

const pressed: string[] = [];
global.fetch = jest.fn(async (url: any) => {
    pressed.push(
        String(url).replace('http://127.0.0.1:8888/api/location/', '')
    );
    return { ok: true } as any;
}) as any;

// The stream as FTC Live sent it in playoffs at the Chelsea Qualifier.
const msg = (updateType: string, number: number, field: number) =>
    JSON.stringify({
        updateTime: 1,
        updateType,
        payload: { number, shortName: `M${number}`, field },
    });

const flush = () =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

describe('FTC Show Match on Match Start', () => {
    beforeEach(() => {
        pressed.length = 0;
    });

    it('playoffs: no SHOW_MATCH, so MATCH_START presses Show Match then Match Start', async () => {
        const sk = new (FtcScorekeeper as any)();
        sk.onMessage(msg('SHOW_PREVIEW', 6, 2));
        sk.onMessage(msg('MATCH_START', 6, 2));
        await flush();
        await flush();
        expect(pressed).toEqual(['1/1/1/press', '2/0/0/press']);
    });

    it('qualifications: SHOW_MATCH came, so MATCH_START presses only Match Start', async () => {
        const sk = new (FtcScorekeeper as any)();
        sk.onMessage(msg('SHOW_MATCH', 7, 2));
        await flush();
        pressed.length = 0;
        sk.onMessage(msg('MATCH_START', 7, 2));
        await flush();
        await flush();
        expect(pressed).toEqual(['2/0/0/press']);
    });

    it('the same match number on the other field is its own match', async () => {
        const sk = new (FtcScorekeeper as any)();
        sk.onMessage(msg('SHOW_MATCH', 8, 2));
        await flush();
        pressed.length = 0;
        sk.onMessage(msg('MATCH_START', 8, 1));
        await flush();
        await flush();
        expect(pressed).toEqual(['1/0/1/press']);
    });
});
