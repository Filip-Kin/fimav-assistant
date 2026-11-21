import FtcScorekeeper from '../main/addons/ftc-scorekeeper';

jest.mock('os', () => ({ networkInterfaces: () => ({}) }));
jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});
jest.mock('../main/bitfocus', () => ({
    companionUrl: () => 'http://127.0.0.1:8888',
}));
jest.mock('../main/store', () => ({
    getStore: () => ({ get: (_k: string, d: unknown) => d }),
}));
if (!(AbortSignal as any).timeout) {
    (AbortSignal as any).timeout = () => new AbortController().signal;
}

type Details = { status: string; start: number; end: number } | 500;

// The real case: usmirhq archived, usmihoq2 live, usmiroq upcoming.
const CODES = ['usmirhq', 'usmihoq2', 'usmiroq'];
const DAY = 86_400_000;
const EVENTS: Record<string, Details> = {
    usmirhq: { status: 'Archived', start: 1 * DAY, end: 2 * DAY },
    usmihoq2: { status: 'Qualifications', start: 20 * DAY, end: 21 * DAY },
    usmiroq: { status: 'Archived', start: 10 * DAY, end: 11 * DAY },
};

let requested: string[] = [];
const serve = (events: Record<string, Details>) => {
    requested = [];
    global.fetch = jest.fn(async (url: any) => {
        const code = String(url).match(/\/events\/([^/]+)\/$/)?.[1] ?? '';
        requested.push(code);
        const d = events[code];
        if (!d || d === 500) return { ok: false, status: 500 } as any;
        return { ok: true, json: async () => ({ name: code, ...d }) } as any;
    }) as any;
};

const pick = async (codes: string[], wanted = '') => {
    const r = await (FtcScorekeeper as any).pickEvent(
        'http://x',
        codes,
        wanted
    );
    return r.code as string;
};

describe('FTC Live event selection', () => {
    it('skips an archived event listed first and takes the live one', async () => {
        serve(EVENTS);
        expect(await pick(CODES)).toBe('usmihoq2');
    });

    it('takes the newest start when several events are not archived', async () => {
        serve({
            ...EVENTS,
            usmirhq: { status: 'Qualifications', start: 5 * DAY, end: 6 * DAY },
        });
        expect(await pick(CODES)).toBe('usmihoq2');
    });

    it('every event archived: newest start', async () => {
        serve({
            usmirhq: { status: 'Archived', start: 1 * DAY, end: 2 * DAY },
            usmihoq2: { status: 'Archived', start: 20 * DAY, end: 21 * DAY },
            usmiroq: { status: 'Archived', start: 10 * DAY, end: 11 * DAY },
        });
        expect(await pick(CODES)).toBe('usmihoq2');
    });

    it('details 500 for one event: that event stays a candidate', async () => {
        serve({ ...EVENTS, usmihoq2: 500 });
        // usmirhq and usmiroq are archived, the 500 event has unknown status.
        expect(await pick(CODES)).toBe('usmihoq2');
    });

    it('details 500 for an archived-first list does not break the pick', async () => {
        serve({ ...EVENTS, usmiroq: 500 });
        expect(await pick(CODES)).toBe('usmihoq2');
    });

    it('details 500 for every event: list order', async () => {
        serve({ usmirhq: 500, usmihoq2: 500, usmiroq: 500 });
        expect(await pick(CODES)).toBe('usmirhq');
    });

    it('an explicit ftc.eventCode wins even when archived', async () => {
        serve(EVENTS);
        expect(await pick(CODES, 'usmirhq')).toBe('usmirhq');
        expect(requested).toEqual(['usmirhq']);
    });

    it('an explicit ftc.eventCode not in the list is ignored', async () => {
        serve(EVENTS);
        expect(await pick(CODES, 'nope')).toBe('usmihoq2');
    });

    it('a single listed event is used as is', async () => {
        serve({ usmirhq: EVENTS.usmirhq });
        expect(await pick(['usmirhq'])).toBe('usmirhq');
    });

    it('an empty list is an error', async () => {
        serve(EVENTS);
        await expect(pick([])).rejects.toThrow('No event');
    });
});
