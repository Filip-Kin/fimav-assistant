import http from 'http';
import startStatusApi, { STATUS_API_PORT } from '../main/api/server';

jest.mock('electron-log', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../main/addons/hw-ping', () => ({
    Instance: {
        currentStatus: {
            camera1: true,
            camera2: false,
            mixer: true,
            switch: true,
            internet: true,
            errors: [],
            ip_errors: [],
            ip_warnings: [],
        },
    },
}));
jest.mock('../main/addons/autoav', () => ({
    Instance: {
        getStatus: () => ({ running: true, saveFolder: null }),
    },
}));
jest.mock('../main/addons/live-captions', () => ({
    Instance: { isRunning: () => true, getVersion: () => '1.2.3' },
}));
jest.mock('../main/recordings/matchStore', () => ({ listMatches: () => [] }));
jest.mock('../main/vmixBandwidth', () => ({
    __esModule: true,
    default: async () => ({
        supported: true,
        streams: [
            {
                index: 1,
                liveKbps: 6000,
                targetKbps: 6000,
                maxrateKbps: 6000,
                destination: 'YouTube (primary)',
                rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/SECRETKEY',
            },
        ],
    }),
}));

const get = (path: string) =>
    new Promise<{ code: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${STATUS_API_PORT}${path}`, (res) => {
            let data = '';
            res.on('data', (c) => {
                data += c;
            });
            res.on('end', () =>
                resolve({ code: res.statusCode ?? 0, body: JSON.parse(data) })
            );
        }).on('error', reject);
    });

describe('status API', () => {
    let server: http.Server;
    beforeAll(async () => {
        server = startStatusApi({
            vmixStatus: async () => ({
                reachable: true,
                recording: false,
                streaming: true,
                keyValidation: {
                    checked: true,
                    match: true,
                    cloudKeys: ['SECRETKEY'],
                    runningKeys: ['SECRETKEY'],
                },
            }),
        });
        await new Promise((resolve) => {
            server.on('listening', resolve);
        });
    });
    afterAll(
        () =>
            new Promise((resolve) => {
                server.close(resolve);
            })
    );

    it('serves each subsystem', async () => {
        expect((await get('/api/status/network')).body.mixer).toBe(true);
        expect((await get('/api/status/vmix')).body).toEqual({
            reachable: true,
            recording: false,
            streaming: true,
        });
        expect((await get('/api/status/autoav')).body.running).toBe(true);
        expect((await get('/api/status/captions')).body.version).toBe('1.2.3');
    });

    it('keeps stream keys out of responses', async () => {
        const { body } = await get('/api/status/stream');
        expect(JSON.stringify(body)).not.toContain('SECRETKEY');
        expect(body.streams[0].liveKbps).toBe(6000);
        expect(body.keyValidation).toEqual({ checked: true, match: true });
    });

    it('combines everything at /api/status', async () => {
        const { body } = await get('/api/status');
        expect(Object.keys(body).sort()).toEqual(
            ['autoav', 'captions', 'network', 'stream', 'vmix'].sort()
        );
    });

    it('404s unknown and prototype names', async () => {
        expect((await get('/api/status/nope')).code).toBe(404);
        expect((await get('/api/status/constructor')).code).toBe(404);
    });
});
