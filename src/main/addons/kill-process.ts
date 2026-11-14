import { execFile } from 'child_process';
import { LogFunctions } from 'electron-log';

// A fix's run() (and the checks tick that follows it) must never block the
// Electron main thread: execSync/spawnSync wait for the child inline, which
// freezes every window (no repaint, no IPC) for as long as tasklist/netstat/
// taskkill take. execFile is the same external command, just awaited instead
// of blocked on. A command stuck for longer than this is treated as failed,
// the same outcome execSync would have had (the caller catches and moves on)
// but without holding up anything else meanwhile.
const TIMEOUT_MS = 5000;

const run = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });

const kill = async (pid: string): Promise<boolean> => {
    try {
        await run('taskkill', ['/F', '/T', '/PID', pid]);
        return true;
    } catch {
        return false; // already gone
    }
};

// Kill every <name>*.exe process, tracked or orphaned, then whatever process
// is still LISTENING on the port. Only the local address of a listening
// socket counts: a line where the port is the REMOTE end is a client of the
// addon (FIM-AV's own keep-alive fetches, vMix's browser input) and must not
// be killed. Our own PID is never killed.
export default async function killByNameAndPort(
    name: string,
    port: number,
    logger: LogFunctions
): Promise<void> {
    const self = String(process.pid);

    // By image name. taskkill's IMAGENAME wildcard filter is rejected on some
    // Win11 builds, so enumerate with tasklist and kill by PID.
    try {
        const tl = await run('tasklist', ['/fo', 'csv', '/nh']);
        const re = new RegExp(`^"(${name}[^"]*\\.exe)","(\\d+)"`, 'i');
        const pids = tl
            .split(/\r?\n/)
            .map((line) => re.exec(line.trim()))
            .filter((m): m is RegExpExecArray => !!m && m[2] !== self)
            .map((m) => m[2]);
        await Promise.all(pids.map((pid) => kill(pid)));
    } catch {
        // tasklist unavailable (non-Windows dev box) - ignore.
    }

    try {
        // No -p filter: "-p tcp" lists IPv4 only, and a dual-stack listener
        // shows up only under IPv6.
        const out = await run('netstat', ['-ano']);
        const pids = new Set<string>();
        out.split(/\r?\n/).forEach((line) => {
            // Proto, Local Address, Foreign Address, State, PID
            const cols = line.trim().split(/\s+/);
            if (cols.length !== 5 || cols[0].toUpperCase() !== 'TCP') return;
            const [, local, , state, pid] = cols;
            if (state !== 'LISTENING') return;
            if (!local.endsWith(`:${port}`)) return;
            if (!/^\d+$/.test(pid) || pid === '0' || pid === self) return;
            pids.add(pid);
        });
        await Promise.all(
            [...pids].map(async (pid) => {
                if (await kill(pid))
                    logger.log(`Freed port ${port} (killed PID ${pid})`);
            })
        );
    } catch {
        // netstat unavailable (non-Windows dev box) - ignore.
    }
}
