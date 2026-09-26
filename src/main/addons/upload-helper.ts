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

// YoutubeUploaderAddon spawns and supervises the youtube-tba-upload process, which
// uploads recorded match videos to YouTube and submits the URLs to The Blue
// Alliance. It shares the fimav-matches.json manifest with FIM-AV in the
// recording folder (see recordings/matchStore.ts). This mirrors LiveCaptions:
// a lazy singleton, a tracked child with an identity-guarded exit handler, a
// killExisting sweep by image name and by port, and a readiness poll before
// reporting running.
//
// The uploader is NOT bundled with the app. Exactly like LiveCaptions, start()
// downloads the versioned Windows .exe (youtube-tba-upload-<version>.exe) from
// the youtube-tba-upload GitHub releases into the app's userData dir, keeps the
// newest one, and auto-updates on launch. Offline (e.g. at a venue) it falls
// back to the newest local copy, and stays stopped only if none was ever
// downloaded.
export default class YoutubeUploaderAddon {
    private static instance: YoutubeUploaderAddon;

    private running = false;

    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

    constructor() {
        this.logs = {
            out: log.scope('youtube-uploader.out'),
            err: log.scope('youtube-uploader.err'),
        };
    }

    // The port the uploader serves its HTTP API on (matches the Go -listen
    // default and the Upload tab's fetch base).
    private static readonly PORT = 8807;

    // FMS + TBA base URLs the uploader needs (Go defaults; passed explicitly so
    // the spawn is self-documenting). FMS is the same field controller AutoAV
    // talks to; TBA is the public trusted-submission endpoint.
    private static readonly FMS_URL = 'http://10.0.100.5';

    private static readonly TBA_URL = 'https://www.thebluealliance.com';

    // Kill every youtube-tba-upload process, tracked or orphaned, by BOTH image
    // name and whatever holds port 8807 — the same belt-and-suspenders sweep
    // LiveCaptions uses, so a wedged prior instance can't keep the port and
    // block the next start.
    private killExisting() {
        try {
            const tl = execSync('tasklist /fo csv /nh').toString();
            tl.split(/\r?\n/).forEach((line) => {
                const m = /^"(youtube-tba-upload[^"]*\.exe)","(\d+)"/i.exec(
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
                    line.includes(`:${YoutubeUploaderAddon.PORT} `) ||
                    line.includes(`:${YoutubeUploaderAddon.PORT}\t`)
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
                        `Freed port ${YoutubeUploaderAddon.PORT} (killed PID ${pid})`
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

    // Poll /api/health until the uploader actually answers, so we only report
    // running once it's serving. Also captures the reported version.
    private async waitForServer(timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await fetch(
                    `http://127.0.0.1:${YoutubeUploaderAddon.PORT}/api/health`,
                    { signal: AbortSignal.timeout(1500) }
                );
                if (res.ok) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        const body = await res.json();
                        if (body?.version) this.currentVersion = body.version;
                    } catch {
                        // health answered but no version - fine
                    }
                    return true;
                }
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

    // The recording folder the uploader watches = the event folder AutoAV is
    // currently filing videos into. A new event is a new folder, so the uploader
    // is restarted (restart()) when it changes.
    // eslint-disable-next-line class-methods-use-this
    private videoDir(): string | null {
        return AutoAV.Instance.getStatus().saveFolder;
    }

    // Start the uploader. Downloads/updates the versioned exe from GitHub
    // releases (best-effort, offline-tolerant) exactly like LiveCaptions, then
    // launches the newest local copy. Returns false (and stays stopped) when
    // there is no recording folder yet, or no exe was ever downloaded.
    public async start(): Promise<boolean> {
        this.killExisting();

        const videoDir = this.videoDir();
        if (!videoDir) {
            this.logs.out.log(
                'No recording folder yet; YouTube uploader will start once an event folder is known'
            );
            this.running = false;
            return false;
        }

        // Newest exe already downloaded, named youtube-tba-upload-<version>.exe
        // in the app's userData dir.
        const found = glob.sync(
            path.join(appdataPath, 'youtube-tba-upload-*.exe')
        );
        let currentVersion = '0.0.0';
        found.forEach((file) => {
            const version = file.split('-').pop()?.split('.exe')[0] ?? '0.0.0';
            if (version > currentVersion) currentVersion = version;
        });

        // Update check + download is best-effort: offline at a venue we fall
        // back to the newest local exe rather than leaving the uploader down.
        try {
            const baseUrl = getStore().get('youtubeUploaderDownloadBase');
            const res = await fetch(`${baseUrl}/latest`, {
                signal: AbortSignal.timeout(8000),
            });
            // "/latest" redirects to the newest release; extract its version.
            const latestVersion = res.url.split('/').pop()?.slice(1) || '0.0.0';
            if (latestVersion > currentVersion) {
                this.logs.out.log(
                    `New YouTube uploader available, currently ${currentVersion}, downloading ${latestVersion}`
                );
                const target = path.join(
                    appdataPath,
                    `youtube-tba-upload-${latestVersion}.exe`
                );
                const stream = fs.createWriteStream(target);
                const { body } = await fetch(
                    `${baseUrl}/download/v${latestVersion}/youtube-tba-upload-${latestVersion}.exe`
                );
                if (body === null)
                    throw new Error('Failed to download YouTube uploader');
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
                'No YouTube uploader executable available (never downloaded and offline)'
            );
            this.running = false;
            return false;
        }

        this.currentVersion = currentVersion;
        return this.launch(
            path.join(appdataPath, `youtube-tba-upload-${currentVersion}.exe`),
            videoDir
        );
    }

    // Launch the exe and confirm it's serving before reporting running. Retries
    // once (with a fresh port sweep) so Restart can recover a wedged instance.
    private async launch(
        exePath: string,
        videoDir: string
    ): Promise<boolean> {
        const args = [
            '-video-dir',
            videoDir,
            '-listen',
            `:${YoutubeUploaderAddon.PORT}`,
            '-fms-url',
            YoutubeUploaderAddon.FMS_URL,
            '-tba-url',
            YoutubeUploaderAddon.TBA_URL,
        ];

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            this.killExisting();

            // Start directly (NO shell wrapper) so this.process is the real exe
            // and kill() takes it down rather than a cmd.exe shell.
            const child = spawn(exePath, args);
            this.process = child;
            child.stdout.on('data', (d) => this.logs.out.info(d.toString()));
            child.stderr.on('data', (d) => this.logs.err.error(d.toString()));
            // Identity-guarded: an OLD child exiting must not clobber a NEWer
            // one started on retry.
            child.on('exit', (code: number | null, signal: string | null) => {
                this.logs.out.log(
                    `YouTube uploader exited (code ${code ?? 'null'}, signal ${
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
                    `YouTube uploader failed to start: ${err.message}`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });

            this.logs.out.log(
                `Starting YouTube uploader, watching ${videoDir}`
            );

            // eslint-disable-next-line no-await-in-loop
            const up = await this.waitForServer();
            if (up && this.process === child && !child.killed) {
                this.running = true;
                this.logs.out.log(
                    `YouTube uploader is serving on port ${YoutubeUploaderAddon.PORT} (v${this.currentVersion})`
                );
                return true;
            }

            this.logs.err.error(
                `YouTube uploader did not come up on attempt ${attempt}${
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''
                }`
            );
        }

        this.killExisting();
        return false;
    }

    // Stop the uploader cleanly: ask it to shut down (closes the browser and
    // checkpoints the WAL), then fall back to the kill sweep on timeout. Exit
    // handlers are identity-guarded, so the fallback kill is harmless.
    public async stop(): Promise<boolean> {
        try {
            await fetch(`http://127.0.0.1:${YoutubeUploaderAddon.PORT}/api/shutdown`, {
                method: 'POST',
                signal: AbortSignal.timeout(5000),
            });
            // Give it a moment to exit on its own before the sweep.
            await new Promise((resolve) => {
                setTimeout(resolve, 800);
            });
        } catch {
            // not reachable / already down - the sweep below handles it
        }
        this.killExisting();
        return true;
    }

    public isRunning(): boolean {
        return this.running;
    }

    public getVersion(): string {
        return this.currentVersion;
    }

    public static get Instance(): YoutubeUploaderAddon {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
