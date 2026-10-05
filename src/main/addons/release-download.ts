import path from 'path';
import fs from 'fs';
import { finished } from 'stream/promises';
import { Readable } from 'node:stream';
import { execSync } from 'child_process';
import glob from 'glob';
import { LogFunctions } from 'electron-log';
import { appdataPath } from '../util';

// Shared plumbing for the addons that run a versioned Windows exe downloaded
// from GitHub releases (LiveCaptions, YoutubeUploaderAddon,
// AudienceDisplayAddon): version parsing and comparison, the update check, the
// download, the kill sweep, and a per-addon start/stop queue.

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const isVersion = (v: string): boolean => VERSION_RE.test(v);

// Numeric semver compare of two x.y.z strings: <0, 0 or >0. A plain string
// compare puts '0.10.0' below '0.9.0'.
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

// Newest <name>-<x.y.z>.exe already downloaded into userData, or '0.0.0' when
// there is none. Names that do not carry a clean version are ignored.
export function newestLocalVersion(name: string): string {
    let current = '0.0.0';
    glob.sync(path.join(appdataPath, `${name}-*.exe`)).forEach((file) => {
        const v = path.basename(file).slice(name.length + 1, -'.exe'.length);
        if (isVersion(v) && compareVersions(v, current) > 0) current = v;
    });
    return current;
}

// Version of the newest release: GitHub's /latest redirects to .../tag/vX.Y.Z.
// Throws on a network error or a non-2xx answer; returns null when the final
// URL does not end in a clean vX.Y.Z tag (treated as "no update").
export async function latestReleaseVersion(
    baseUrl: string
): Promise<string | null> {
    const res = await fetch(`${baseUrl}/latest`, {
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Update check: HTTP ${res.status}`);
    const tag = res.url.split('/').pop() ?? '';
    const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
    return m ? m[1] : null;
}

// Download <baseUrl>/download/v<version>/<name>-<version>.exe into userData.
// The bytes go to a .part file that is renamed only once the download is
// complete, so a failed or cut-off download never leaves a broken exe under
// the name start() launches.
export async function downloadRelease(
    baseUrl: string,
    name: string,
    version: string
): Promise<void> {
    const target = path.join(appdataPath, `${name}-${version}.exe`);
    const part = `${target}.part`;
    try {
        const res = await fetch(
            `${baseUrl}/download/v${version}/${name}-${version}.exe`,
            { signal: AbortSignal.timeout(15 * 60 * 1000) }
        );
        if (!res.ok || res.body === null) {
            throw new Error(`Download of ${name}: HTTP ${res.status}`);
        }
        // Node's Readable.fromWeb typing lags the DOM stream type.
        const body = Readable.fromWeb(res.body as any);
        await finished(body.pipe(fs.createWriteStream(part)));
        fs.renameSync(part, target);
    } catch (e) {
        try {
            fs.rmSync(part, { force: true });
        } catch {
            // nothing to clean up
        }
        throw e;
    }
}

const kill = (pid: string): boolean => {
    try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
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
export function killByNameAndPort(
    name: string,
    port: number,
    logger: LogFunctions
): void {
    const self = String(process.pid);

    // By image name. taskkill's IMAGENAME wildcard filter is rejected on some
    // Win11 builds, so enumerate with tasklist and kill by PID.
    try {
        const tl = execSync('tasklist /fo csv /nh').toString();
        const re = new RegExp(`^"(${name}[^"]*\\.exe)","(\\d+)"`, 'i');
        tl.split(/\r?\n/).forEach((line) => {
            const m = re.exec(line.trim());
            if (m && m[2] !== self) kill(m[2]);
        });
    } catch {
        // tasklist unavailable (non-Windows dev box) - ignore.
    }

    try {
        // No -p filter: "-p tcp" lists IPv4 only, and a dual-stack listener
        // shows up only under IPv6.
        const out = execSync('netstat -ano').toString();
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
        pids.forEach((pid) => {
            if (kill(pid)) logger.log(`Freed port ${port} (killed PID ${pid})`);
        });
    } catch {
        // netstat unavailable (non-Windows dev box) - ignore.
    }
}

// Runs async jobs one at a time, in call order. Each addon routes start() and
// stop() through one of these so two callers (boot, the season-change
// handler, a Restart click) cannot interleave and kill each other's child.
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(job: () => Promise<T>): Promise<T> {
        const result = this.tail.then(job);
        this.tail = result.catch(() => undefined);
        return result;
    }
}
