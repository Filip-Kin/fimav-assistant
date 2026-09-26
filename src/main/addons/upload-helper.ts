import { ChildProcessWithoutNullStreams, spawn, execSync } from 'child_process';
import fs from 'fs';
import log from 'electron-log';
import { getAssetPath } from '../util';
import { AddonLoggers } from './addon-loggers';
import AutoAV from './autoav';

// UploadHelper spawns and supervises the youtube-tba-upload Go sidecar, which
// uploads recorded match videos to YouTube and submits the URLs to The Blue
// Alliance. It shares one SQLite database with FIM-AV in the recording folder
// (see recordings/db.ts). This mirrors LiveCaptions: a lazy singleton, a
// tracked child with an identity-guarded exit handler, a killExisting sweep by
// image name and by port, and a readiness poll before reporting running.
//
// The sidecar is a Windows .exe shipped under assets/youtube-tba-upload/ (it
// won't exist in the repo; assets/youtube-tba-upload/ is populated at package
// time from the youtube-tba-upload repo's release build). start() logs a clear
// error and stays stopped if the binary is missing.
export default class UploadHelper {
    private static instance: UploadHelper;

    private running = false;

    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

    constructor() {
        this.logs = {
            out: log.scope('upload-helper.out'),
            err: log.scope('upload-helper.err'),
        };
    }

    // The port the sidecar serves its HTTP API on (matches the Go -listen
    // default and the Upload tab's fetch base).
    private static readonly PORT = 8807;

    // FMS + TBA base URLs the sidecar needs (Go defaults; passed explicitly so
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
                    line.includes(`:${UploadHelper.PORT} `) ||
                    line.includes(`:${UploadHelper.PORT}\t`)
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
                        `Freed port ${UploadHelper.PORT} (killed PID ${pid})`
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

    // Poll /api/health until the sidecar actually answers, so we only report
    // running once it's serving. Also captures the reported version.
    private async waitForServer(timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await fetch(
                    `http://127.0.0.1:${UploadHelper.PORT}/api/health`,
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

    // The recording folder the sidecar watches = the event folder AutoAV is
    // currently filing videos into. A new event is a new folder, so the sidecar
    // is restarted (restart()) when it changes.
    // eslint-disable-next-line class-methods-use-this
    private videoDir(): string | null {
        return AutoAV.Instance.getStatus().saveFolder;
    }

    // Start the sidecar. Returns false (and stays stopped) when there is no
    // recording folder yet or the binary is missing.
    public async start(): Promise<boolean> {
        this.killExisting();

        const videoDir = this.videoDir();
        if (!videoDir) {
            this.logs.out.log(
                'No recording folder yet; upload sidecar will start once an event folder is known'
            );
            this.running = false;
            return false;
        }

        const exePath = getAssetPath(
            'youtube-tba-upload',
            'youtube-tba-upload.exe'
        );
        if (!fs.existsSync(exePath)) {
            this.logs.err.error(
                `youtube-tba-upload.exe not found at ${exePath}. It is bundled at package time from the youtube-tba-upload release build; the Upload tab will stay stopped until it is present.`
            );
            this.running = false;
            return false;
        }

        return this.startSidecar(exePath, videoDir);
    }

    // Launch the exe and confirm it's serving before reporting running. Retries
    // once (with a fresh port sweep) so Restart can recover a wedged instance.
    private async startSidecar(
        exePath: string,
        videoDir: string
    ): Promise<boolean> {
        const args = [
            '-video-dir',
            videoDir,
            '-listen',
            `:${UploadHelper.PORT}`,
            '-fms-url',
            UploadHelper.FMS_URL,
            '-tba-url',
            UploadHelper.TBA_URL,
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
                    `Upload sidecar exited (code ${code ?? 'null'}, signal ${
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
                    `Upload sidecar failed to start: ${err.message}`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });

            this.logs.out.log(
                `Starting upload sidecar, watching ${videoDir}`
            );

            // eslint-disable-next-line no-await-in-loop
            const up = await this.waitForServer();
            if (up && this.process === child && !child.killed) {
                this.running = true;
                this.logs.out.log(
                    `Upload sidecar is serving on port ${UploadHelper.PORT} (v${this.currentVersion})`
                );
                return true;
            }

            this.logs.err.error(
                `Upload sidecar did not come up on attempt ${attempt}${
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''
                }`
            );
        }

        this.killExisting();
        return false;
    }

    // Stop the sidecar cleanly: ask it to shut down (closes the browser and
    // checkpoints the WAL), then fall back to the kill sweep on timeout. Exit
    // handlers are identity-guarded, so the fallback kill is harmless.
    public async stop(): Promise<boolean> {
        try {
            await fetch(`http://127.0.0.1:${UploadHelper.PORT}/api/shutdown`, {
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

    public static get Instance(): UploadHelper {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
