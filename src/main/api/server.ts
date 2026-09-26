import http from 'http';
import { networkInterfaces } from 'os';
import log from 'electron-log';
import HWPing from '../addons/hw-ping';
import AutoAV from '../addons/autoav';
import LiveCaptions from '../addons/live-captions';
import getVmixBandwidth, { VmixBandwidth } from '../vmixBandwidth';
import { listMatches } from '../recordings/matchStore';

// Read-only status API on the LAN, one endpoint per subsystem, for Companion
// or anything else on the cart network to poll. No auth by design: every
// response is status only and nothing here changes state.
export const STATUS_API_PORT = 7780;

// vMix status is built inside register-events (it owns the stream-key
// validation state), so it is passed in rather than rebuilt here.
export type StatusApiSources = {
    vmixStatus: () => Promise<{
        reachable: boolean;
        recording: boolean;
        streaming: boolean;
        [key: string]: unknown;
    }>;
};

const sleep = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

// The first bandwidth read after a quiet period has no baseline and reports
// warming with no streams; read once more past the cache window for a real
// answer.
async function bandwidth(): Promise<VmixBandwidth> {
    const bw = await getVmixBandwidth();
    if (!bw.warming) return bw;
    await sleep(2100);
    return getVmixBandwidth();
}

function localIpv4() {
    return Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
        (addrs ?? [])
            .filter((a) => a.family === 'IPv4' && !a.internal)
            .map((a) => ({ interface: name, address: a.address }))
    );
}

export default function startStatusApi(sources: StatusApiSources) {
    const routes: Record<string, () => Promise<unknown> | unknown> = {
        network: () => ({
            ...HWPing.Instance.currentStatus,
            interfaces: localIpv4(),
        }),
        vmix: async () => {
            const { reachable, recording, streaming } =
                await sources.vmixStatus();
            return { reachable, recording, streaming };
        },
        stream: async () => {
            const [status, bw] = await Promise.all([
                sources.vmixStatus(),
                bandwidth(),
            ]);
            return {
                streaming: status.streaming,
                currentEvent: status.currentEvent,
                keysSetForEvent: status.keysSetForEvent,
                streamKeys: status.streamKeys,
                // Only the verdict: the key lists are live stream keys.
                keyValidation: (() => {
                    const kv = status.keyValidation as
                        | { checked: boolean; match: boolean | null }
                        | undefined;
                    return kv ? { checked: kv.checked, match: kv.match } : null;
                })(),
                bandwidthSupported: bw.supported,
                // Stream keys stay off the LAN: drop the rtmp URL.
                streams: bw.streams.map(({ rtmpUrl: _rtmpUrl, ...s }) => s),
            };
        },
        autoav: () => {
            const status = AutoAV.Instance.getStatus();
            return {
                ...status,
                matches: listMatches(status.saveFolder).slice(0, 20),
            };
        },
        captions: () => ({
            running: LiveCaptions.Instance.isRunning(),
            version: LiveCaptions.Instance.getVersion(),
        }),
    };

    const all = async () => {
        const entries = await Promise.all(
            Object.entries(routes).map(async ([k, fn]) => [k, await fn()])
        );
        return Object.fromEntries(entries);
    };

    const server = http.createServer(async (req, res) => {
        const send = (code: number, body: unknown) => {
            res.writeHead(code, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
        };

        if (req.method !== 'GET') {
            send(405, { error: 'method not allowed' });
            return;
        }

        const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
        const m = /^\/api\/status(?:\/([a-z]+))?$/.exec(path);
        if (!m) {
            send(404, {
                error: 'not found',
                endpoints: [
                    '/api/status',
                    ...Object.keys(routes).map((k) => `/api/status/${k}`),
                ],
            });
            return;
        }

        let handler: (() => unknown) | null = all;
        if (m[1]) {
            handler = Object.prototype.hasOwnProperty.call(routes, m[1])
                ? routes[m[1]]
                : null;
        }
        if (!handler) {
            send(404, { error: `unknown status "${m[1]}"` });
            return;
        }

        try {
            send(200, await handler());
        } catch (e) {
            log.error(`Status API ${path} failed`, e);
            send(500, { error: (e as Error).message });
        }
    });

    server.on('error', (e) => log.error('Status API server error', e));
    server.listen(STATUS_API_PORT, '0.0.0.0', () =>
        log.info(`Status API listening on :${STATUS_API_PORT}`)
    );
    return server;
}
