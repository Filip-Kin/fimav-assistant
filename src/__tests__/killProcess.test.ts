/**
 * killByNameAndPort used execSync (tasklist, netstat, taskkill) and blocked
 * the Electron main thread for as long as those took - including when run
 * from a check's Fix button, which froze the whole window until it
 * finished. Converted to execFile + Promise.all (kill-process.ts, 2026-11-14).
 * These tests mock child_process to prove the exact commands/args it runs
 * and that it never throws out when a command is unavailable (the non-
 * Windows dev box path it already had to tolerate).
 */
type ExecFileCallback = (
    _err: Error | null,
    _stdout: string,
    _stderr: string
) => void;

type Handler = (_args: string[]) => { stdout?: string; err?: Error };

let handlers: Record<string, Handler> = {};
const execFileCalls: { cmd: string; args: string[] }[] = [];

jest.mock('child_process', () => ({
    execFile: (
        cmd: string,
        args: string[],
        _opts: unknown,
        cb: ExecFileCallback
    ) => {
        execFileCalls.push({ cmd, args });
        const h = handlers[cmd];
        const { stdout, err } = h
            ? h(args)
            : { stdout: '', err: undefined };
        // execFile is genuinely async; a same-tick callback would hide a
        // caller that forgot to await it. setTimeout, not setImmediate:
        // this suite's jsdom test environment has no setImmediate global.
        setTimeout(() => cb(err ?? null, stdout ?? '', ''), 0);
    },
}));

// eslint-disable-next-line import/first
import killByNameAndPort from '../main/addons/kill-process';

const logger = { log: jest.fn() } as any;

const realPid = Object.getOwnPropertyDescriptor(process, 'pid')!;

beforeEach(() => {
    handlers = {};
    execFileCalls.length = 0;
    logger.log.mockClear();
    Object.defineProperty(process, 'pid', { value: 999, configurable: true });
});

afterEach(() => {
    Object.defineProperty(process, 'pid', realPid);
    jest.restoreAllMocks();
});

describe('killByNameAndPort', () => {
    it('kills every matching image name by PID, skipping our own PID', async () => {
        handlers.tasklist = () => ({
            stdout: [
                '"live-captions.exe","111","Console","1","20,000 K"',
                '"live-captions-old.exe","222","Console","1","20,000 K"',
                '"live-captions.exe","999","Console","1","20,000 K"', // self
                '"vMix64.exe","333","Console","1","20,000 K"',
            ].join('\r\n'),
        });
        handlers.netstat = () => ({ stdout: '' });
        handlers.taskkill = () => ({ stdout: '' });

        await killByNameAndPort('live-captions', 3000, logger);

        const taskkills = execFileCalls.filter((c) => c.cmd === 'taskkill');
        expect(taskkills.map((c) => c.args)).toEqual(
            expect.arrayContaining([
                ['/F', '/T', '/PID', '111'],
                ['/F', '/T', '/PID', '222'],
            ])
        );
        expect(taskkills.some((c) => c.args.includes('999'))).toBe(false);
        expect(taskkills.some((c) => c.args.includes('333'))).toBe(false);
    });

    it('kills whatever is LISTENING on the port, ignoring remote-end matches and non-LISTENING rows', async () => {
        handlers.tasklist = () => ({ stdout: '' });
        handlers.netstat = () => ({
            stdout: [
                '  Proto  Local Address          Foreign Address        State           PID',
                '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       444',
                // Foreign (remote) end happens to be :3000 - must not count.
                '  TCP    127.0.0.1:51000        127.0.0.1:3000         ESTABLISHED     555',
                // Right port, but not listening.
                '  TCP    0.0.0.0:3000           0.0.0.0:0              CLOSE_WAIT      666',
                // Our own PID listening on the port - never killed.
                '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       999',
            ].join('\r\n'),
        });
        handlers.taskkill = () => ({ stdout: '' });

        await killByNameAndPort('live-captions', 3000, logger);

        const taskkills = execFileCalls.filter((c) => c.cmd === 'taskkill');
        expect(taskkills).toHaveLength(1);
        expect(taskkills[0].args).toEqual(['/F', '/T', '/PID', '444']);
        expect(logger.log).toHaveBeenCalledWith(
            'Freed port 3000 (killed PID 444)'
        );
    });

    it('a taskkill that fails for one PID does not stop the others', async () => {
        handlers.tasklist = () => ({ stdout: '' });
        handlers.netstat = () => ({
            stdout: [
                '  TCP    0.0.0.0:3000  0.0.0.0:0  LISTENING  111',
                '  TCP    0.0.0.0:3000  0.0.0.0:0  LISTENING  222',
            ].join('\r\n'),
        });
        handlers.taskkill = (args) =>
            args.includes('111')
                ? { err: new Error('Access denied') }
                : { stdout: '' };

        await expect(
            killByNameAndPort('live-captions', 3000, logger)
        ).resolves.toBeUndefined();

        expect(logger.log).toHaveBeenCalledWith(
            'Freed port 3000 (killed PID 222)'
        );
        expect(logger.log).not.toHaveBeenCalledWith(
            expect.stringContaining('111')
        );
    });

    it('tasklist/netstat missing (non-Windows dev box) resolves instead of throwing', async () => {
        handlers.tasklist = () => ({ err: new Error('ENOENT') });
        handlers.netstat = () => ({ err: new Error('ENOENT') });

        await expect(
            killByNameAndPort('live-captions', 3000, logger)
        ).resolves.toBeUndefined();
        expect(logger.log).not.toHaveBeenCalled();
    });

    it('runs every external command through execFile, never a shell exec', async () => {
        handlers.tasklist = () => ({ stdout: '' });
        handlers.netstat = () => ({ stdout: '' });

        await killByNameAndPort('live-captions', 3000, logger);

        expect(execFileCalls.map((c) => c.cmd)).toEqual([
            'tasklist',
            'netstat',
        ]);
    });
});
