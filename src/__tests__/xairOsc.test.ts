import dgram from 'dgram';
import { queryXair, setXair, writeXair } from '../main/checks/xair';
import { dbToLevel, FADER_STEPS } from '../utils/xairLaw';

// A fake X-Air: answers a query (address, no arguments) with the value it
// holds and stores a set (address with one float or int), the way the
// mixer does on UDP 10024. Sets are not acknowledged.
function pad4(b: Buffer) {
    const out = Buffer.alloc(Math.ceil((b.length + 1) / 4) * 4);
    b.copy(out);
    return out;
}

function str(buf: Buffer, at: number): [string, number] {
    const end = buf.indexOf(0, at);
    return [buf.toString('ascii', at, end), Math.ceil((end + 1) / 4) * 4];
}

function fakeXair(state: Map<string, { t: 'f' | 'i'; v: number }>) {
    const sock = dgram.createSocket('udp4');
    const log: string[] = [];
    sock.on('message', (msg, rinfo) => {
        const [address, a] = str(msg, 0);
        const [tags, b] = str(msg, a);
        if (tags === ',') {
            const cur = state.get(address);
            if (!cur) return;
            const val = Buffer.alloc(4);
            if (cur.t === 'f') val.writeFloatBE(cur.v);
            else val.writeInt32BE(cur.v);
            sock.send(
                Buffer.concat([
                    pad4(Buffer.from(address)),
                    pad4(Buffer.from(`,${cur.t}`)),
                    val,
                ]),
                rinfo.port,
                rinfo.address
            );
            return;
        }
        log.push(`${address} ${tags}`);
        if (tags === ',f')
            state.set(address, { t: 'f', v: msg.readFloatBE(b) });
        if (tags === ',i')
            state.set(address, { t: 'i', v: msg.readInt32BE(b) });
    });
    return new Promise<{ port: number; close: () => void; log: string[] }>(
        (resolve) => {
            sock.bind(0, '127.0.0.1', () =>
                resolve({
                    port: sock.address().port,
                    close: () => sock.close(),
                    log,
                })
            );
        }
    );
}

describe('X-Air OSC writes', () => {
    it('sets faders and reads them back', async () => {
        const state = new Map<string, { t: 'f' | 'i'; v: number }>([
            ['/lr/mix/fader', { t: 'f', v: 0.75 }],
            ['/ch/03/mix/01/grpon', { t: 'i', v: 1 }],
        ]);
        const x = await fakeXair(state);
        try {
            const lr = dbToLevel(-50, FADER_STEPS);
            const got = await setXair(
                '127.0.0.1',
                [
                    { address: '/lr/mix/fader', value: lr },
                    { address: '/ch/03/mix/01/grpon', value: 0, int: true },
                ],
                x.port
            );
            expect(x.log).toEqual([
                '/lr/mix/fader ,f',
                '/ch/03/mix/01/grpon ,i',
            ]);
            // Float32 on the wire.
            expect(got.get('/lr/mix/fader')).toBeCloseTo(lr, 6);
            expect(got.get('/ch/03/mix/01/grpon')).toBe(0);
        } finally {
            x.close();
        }
    });

    it('a fire-and-forget write lands; a missing address is not answered', async () => {
        const state = new Map<string, { t: 'f' | 'i'; v: number }>([
            ['/ch/01/mix/fader', { t: 'f', v: 0.5 }],
        ]);
        const x = await fakeXair(state);
        try {
            await writeXair(
                '127.0.0.1',
                [{ address: '/ch/01/mix/fader', value: 0.6 }],
                x.port
            );
            const got = await queryXair(
                '127.0.0.1',
                ['/ch/01/mix/fader', '/ch/09/mix/fader'],
                1500,
                x.port
            );
            expect(got.get('/ch/01/mix/fader')).toBeCloseTo(0.6, 6);
            expect(got.has('/ch/09/mix/fader')).toBe(false);
        } finally {
            x.close();
        }
    });
});
