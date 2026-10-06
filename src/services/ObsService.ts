/* eslint-disable class-methods-use-this */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

// OBS Studio's built-in websocket server (OBS 28+, obs-websocket protocol
// v5), standing in for vMix's recording calls in the OBS build. Address and
// password come from OBS's own websocket config on this PC, so nothing is
// set up twice: %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json.
// In OBS: Tools > WebSocket Server Settings > Enable WebSocket server.

type ObsConfig = { url: string; password: string | null };

function readObsConfig(): ObsConfig {
    const file = path.join(
        process.env.APPDATA ?? '',
        'obs-studio',
        'plugin_config',
        'obs-websocket',
        'config.json'
    );
    try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            url: `ws://127.0.0.1:${c.server_port ?? 4455}`,
            password: c.auth_required ? c.server_password ?? '' : null,
        };
    } catch {
        return { url: 'ws://127.0.0.1:4455', password: null };
    }
}

const sha256b64 = (s: string) =>
    crypto.createHash('sha256').update(s).digest('base64');

// One request on a short-lived connection: Hello, Identify, Request,
// Response. Rejects on a failed request or after `timeoutMs`.
function obsRequest(
    requestType: string,
    requestData: Record<string, unknown> = {},
    timeoutMs = 5000
): Promise<any> {
    const { url, password } = readObsConfig();
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('OBS not answering'));
        }, timeoutMs);
        const done = (fn: () => void) => {
            clearTimeout(timer);
            ws.close();
            fn();
        };
        ws.on('error', (e) => done(() => reject(e)));
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.op === 0) {
                const auth = msg.d.authentication;
                const identify: Record<string, unknown> = {
                    rpcVersion: 1,
                    eventSubscriptions: 0,
                };
                if (auth) {
                    if (password === null) {
                        done(() => reject(new Error('OBS needs a password')));
                        return;
                    }
                    identify.authentication = sha256b64(
                        sha256b64(password + auth.salt) + auth.challenge
                    );
                }
                ws.send(JSON.stringify({ op: 1, d: identify }));
            } else if (msg.op === 2) {
                ws.send(
                    JSON.stringify({
                        op: 6,
                        d: { requestType, requestId: '1', requestData },
                    })
                );
            } else if (msg.op === 7) {
                const st = msg.d.requestStatus;
                if (st?.result) done(() => resolve(msg.d.responseData ?? {}));
                else
                    done(() =>
                        reject(
                            new Error(
                                `OBS ${requestType}: ${st?.comment ?? st?.code}`
                            )
                        )
                    );
            }
        });
    });
}

export default class ObsService {
    private static instance: ObsService;

    // Path of the file the last StopRecord finished.
    private lastOutputPath: string | null = null;

    async StartRecording(): Promise<void> {
        await obsRequest('StartRecord');
    }

    async StopRecording(): Promise<void> {
        const r = await obsRequest('StopRecord');
        this.lastOutputPath = r.outputPath ?? null;
    }

    async isRecording(): Promise<boolean> {
        const r = await obsRequest('GetRecordStatus');
        return !!r.outputActive;
    }

    // OBS only names the file when recording stops; Auto AV renames it
    // after StopRecording, so this is the file just finished.
    async GetCurrentRecording(): Promise<string> {
        return this.lastOutputPath ?? '';
    }

    async GetRecordingFolder(): Promise<string | null> {
        const r = await obsRequest('GetRecordDirectory');
        return r.recordDirectory ?? null;
    }

    // For status: reachable, recording, and the record folder.
    async Status(): Promise<{
        reachable: boolean;
        recording: boolean;
        folder: string | null;
    }> {
        try {
            const [st, dir] = await Promise.all([
                obsRequest('GetRecordStatus'),
                obsRequest('GetRecordDirectory'),
            ]);
            return {
                reachable: true,
                recording: !!st.outputActive,
                folder: dir.recordDirectory ?? null,
            };
        } catch {
            return { reachable: false, recording: false, folder: null };
        }
    }

    // eslint-disable-next-line class-methods-use-this
    getUrl(): string {
        return readObsConfig().url;
    }

    public static get Instance(): ObsService {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
