import path from 'path';
import fs from 'fs';
import { finished } from 'stream/promises';
import { Readable } from 'node:stream';
import { ChildProcessWithoutNullStreams, spawn, execSync } from 'child_process';
import glob from 'glob';
import log from 'electron-log';
import { appdataPath } from '../util';
import { AddonLoggers } from './addon-loggers';
import { getStore } from '../store';
import AutoAV from './autoav';

// AudienceDisplayAddon spawns and supervises the custom audience display
// (Filip-Kin/audience-display), the off-season replacement for the FMS
// audience display. Same shape as LiveCaptions and YoutubeUploaderAddon: a
// lazy singleton, a tracked child with an identity-guarded exit handler, a
// killExisting sweep by image name and by port, and a readiness poll before
// reporting running.
//
// The exe is NOT bundled. start() downloads the versioned Windows exe
// (audience-display-<version>.exe) from the GitHub releases into the app's
// userData dir, keeps the newest one, and updates on launch. The exe's own
// auto-update is turned off (AUTO_UPDATE=0) so this addon stays the one thing
// that decides which version runs. It runs only at FRC off-season events with
// "Custom AD" picked in Settings; otherwise start() refuses.
export default class AudienceDisplayAddon {
    private static instance: AudienceDisplayAddon;

    private running = false;

    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

    constructor() {
        this.logs = {
            out: log.scope('audience-display.out'),
            err: log.scope('audience-display.err'),
        };
    }

    // The port the display serves its UI, API and websocket on.
    public static readonly PORT = 3001;

    public static readonly URL = `http://127.0.0.1:${AudienceDisplayAddon.PORT}`;

    private killExisting() {
        try {
            const tl = execSync('tasklist /fo csv /nh').toString();
            tl.split(/\r?\n/).forEach((line) => {
                const m = /^"(audience-display[^"]*\.exe)","(\d+)"/i.exec(
                    line.trim()
                );
                if (m) {
                    try {
                        execSync(`taskkill /F /T /PID ${m[2]}`, {
                            stdio: 'ignore',
                        });
                    } catch {
                        // already gone
                    }
                }
            });
        } catch {
            // tasklist unavailable (non-Windows dev box) - ignore.
        }

        try {
            const out = execSync('netstat -ano -p tcp').toString();
            const pids = new Set<string>();
            out.split(/\r?\n/).forEach((line) => {
                if (
                    line.includes(`:${AudienceDisplayAddon.PORT} `) ||
                    line.includes(`:${AudienceDisplayAddon.PORT}\t`)
                ) {
                    const cols = line.trim().split(/\s+/);
                    const pid = cols[cols.length - 1];
                    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
                }
            });
            pids.forEach((pid) => {
                try {
                    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
                    this.logs.out.log(
                        `Freed port ${AudienceDisplayAddon.PORT} (killed PID ${pid})`
                    );
                } catch {
                    // ignore
                }
            });
        } catch {
            // netstat unavailable (non-Windows dev box) - ignore.
        }

        this.running = false;
        this.process = null;
    }

    // Poll the display's HTTP server until it answers, so we only report
    // running once it is serving.
    // eslint-disable-next-line class-methods-use-this
    private async waitForServer(timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await fetch(`${AudienceDisplayAddon.URL}/`, {
                    signal: AbortSignal.timeout(1500),
                });
                if (res.ok || res.status < 500) return true;
            } catch {
                // not up yet
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
        }
        return false;
    }

    // Newest exe already downloaded, named audience-display-<version>.exe in
    // the app's userData dir.
    // eslint-disable-next-line class-methods-use-this
    private localVersion(): string {
        let current = '0.0.0';
        glob.sync(path.join(appdataPath, 'audience-display-*.exe')).forEach(
            (file) => {
                const v = file.split('-').pop()?.split('.exe')[0] ?? '0.0.0';
                if (v > current) current = v;
            }
        );
        return current;
    }

    public async start(): Promise<boolean> {
        this.killExisting();

        // The custom display runs at FRC off-season events when Settings
        // picks it over the official FMS display.
        if (!AutoAV.Instance.runsCustomAd()) {
            this.logs.out.log('Custom audience display not selected; off');
            this.running = false;
            return false;
        }

        let currentVersion = this.localVersion();

        // Update check + download is best-effort: offline at a venue we fall
        // back to the newest local exe rather than leaving the display down.
        try {
            const baseUrl = getStore().get('audienceDisplayDownloadBase');
            const res = await fetch(`${baseUrl}/latest`, {
                signal: AbortSignal.timeout(8000),
            });
            // "/latest" redirects to the newest release; extract its version.
            const latestVersion = res.url.split('/').pop()?.slice(1) || '0.0.0';
            if (latestVersion > currentVersion) {
                this.logs.out.log(
                    `New audience display available, currently ${currentVersion}, downloading ${latestVersion}`
                );
                const target = path.join(
                    appdataPath,
                    `audience-display-${latestVersion}.exe`
                );
                const stream = fs.createWriteStream(target);
                const { body } = await fetch(
                    `${baseUrl}/download/v${latestVersion}/audience-display-${latestVersion}.exe`
                );
                if (body === null)
                    throw new Error('Failed to download the audience display');
                // @ts-ignore Node's Readable.fromWeb typing lags the DOM stream
                await finished(Readable.fromWeb(body).pipe(stream));
                currentVersion = latestVersion;
            }
        } catch (e) {
            this.logs.err.warn(
                `Update check failed, using local v${currentVersion}`,
                e
            );
        }

        if (currentVersion === '0.0.0') {
            this.logs.err.error(
                'No audience display executable available (never downloaded and offline)'
            );
            this.running = false;
            return false;
        }

        this.currentVersion = currentVersion;
        return this.launch(
            path.join(appdataPath, `audience-display-${currentVersion}.exe`)
        );
    }

    // Launch the exe and confirm it is serving before reporting running.
    // Retries once (with a fresh port sweep) so Restart can recover a wedged
    // instance.
    private async launch(exePath: string): Promise<boolean> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            this.killExisting();

            // The exe unpacks its UI into ./.temp relative to its working
            // directory, so run it from the userData dir, where the exe lives.
            // Its own auto-update is off: this addon picks the version.
            const child = spawn(exePath, [], {
                cwd: appdataPath,
                env: { ...process.env, AUTO_UPDATE: '0' },
            });
            this.process = child;
            child.stdout.on('data', (d) => this.logs.out.info(d.toString()));
            child.stderr.on('data', (d) => this.logs.err.error(d.toString()));
            child.on('exit', (code: number | null, signal: string | null) => {
                this.logs.out.log(
                    `Audience display exited (code ${code ?? 'null'}, signal ${
                        signal ?? 'none'
                    })`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });
            child.on('error', (err) => {
                this.logs.err.error(
                    `Audience display failed to start: ${err.message}`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });

            this.logs.out.log(
                `Starting audience display v${this.currentVersion}`
            );

            // eslint-disable-next-line no-await-in-loop
            const up = await this.waitForServer();
            if (up && this.process === child && !child.killed) {
                this.running = true;
                this.logs.out.log(
                    `Audience display is serving on port ${AudienceDisplayAddon.PORT}`
                );
                return true;
            }

            this.logs.err.error(
                `Audience display did not come up on attempt ${attempt}${
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''
                }`
            );
        }

        this.killExisting();
        return false;
    }

    public stop(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.killExisting();
            resolve(true);
        });
    }

    public isRunning(): boolean {
        return this.running;
    }

    public getVersion(): string {
        return this.currentVersion;
    }

    // Check GitHub for a newer audience display without downloading it.
    public async checkForUpdate(): Promise<{
        current: string;
        latest: string;
        updateAvailable: boolean;
    }> {
        const current = this.localVersion();
        let latest = current;
        try {
            const baseUrl = getStore().get('audienceDisplayDownloadBase');
            const res = await fetch(`${baseUrl}/latest`, {
                signal: AbortSignal.timeout(8000),
            });
            latest = res.url.split('/').pop()?.slice(1) || current;
        } catch (e) {
            this.logs.err.warn('Update check failed', e);
        }
        return { current, latest, updateAvailable: latest > current };
    }

    public static get Instance(): AudienceDisplayAddon {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
