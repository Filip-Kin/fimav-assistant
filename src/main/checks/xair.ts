import dgram from 'dgram';

// Read-only OSC queries to a Behringer X-Air mixer (XR12/16/18) on UDP 10024.
// Sending an address with no arguments asks the mixer for its value; it
// answers on the same socket with the address and one argument. Addresses
// are the ones the Bitfocus X-Air module uses:
//   /ch/NN/config/name       channel name (s)
//   /ch/NN/mix/on            1 = unmuted (i)
//   /ch/NN/mix/fader         0..1, 0.75 = 0 dB (f)
//   /ch/NN/mix/lr            1 = assigned to the main mix (i)
//   /ch/NN/mix/BB/level      send level to bus BB, 0..1 (f)
//   /rtn/aux/...             the same for the aux/USB return (17+18)
// Nothing here ever writes to the mixer.

export const XAIR_PORT = 10024;

type OscValue = string | number;

function pad4(b: Buffer): Buffer {
    const len = Math.ceil((b.length + 1) / 4) * 4;
    const out = Buffer.alloc(len);
    b.copy(out);
    return out;
}

// An OSC message with an address and no arguments.
function encodeQuery(address: string): Buffer {
    return Buffer.concat([
        pad4(Buffer.from(address, 'ascii')),
        pad4(Buffer.from(',', 'ascii')),
    ]);
}

function readString(buf: Buffer, at: number): [string, number] {
    const end = buf.indexOf(0, at);
    const s = buf.toString('ascii', at, end);
    return [s, Math.ceil((end + 1) / 4) * 4];
}

// The address and first argument of an OSC reply, or null.
export function decodeReply(
    buf: Buffer
): { address: string; value: OscValue } | null {
    try {
        const [address, a] = readString(buf, 0);
        const [tags, b] = readString(buf, a);
        if (!tags.startsWith(',') || tags.length < 2) return null;
        switch (tags[1]) {
            case 'i':
                return { address, value: buf.readInt32BE(b) };
            case 'f':
                return { address, value: buf.readFloatBE(b) };
            case 's':
                return { address, value: readString(buf, b)[0] };
            default:
                return null;
        }
    } catch {
        return null;
    }
}

// Ask the mixer for several addresses at once. Answers that do not arrive
// within `timeoutMs` are missing from the result.
export function queryXair(
    host: string,
    addresses: string[],
    timeoutMs = 800
): Promise<Map<string, OscValue>> {
    return new Promise((resolve) => {
        const results = new Map<string, OscValue>();
        const socket = dgram.createSocket('udp4');
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // already closed
            }
            resolve(results);
        };
        const timer = setTimeout(finish, timeoutMs);
        socket.on('message', (msg) => {
            const reply = decodeReply(msg);
            if (reply && addresses.includes(reply.address)) {
                results.set(reply.address, reply.value);
                if (results.size === addresses.length) finish();
            }
        });
        socket.on('error', finish);
        socket.bind(0, () => {
            addresses.forEach((a) =>
                socket.send(encodeQuery(a), XAIR_PORT, host, () => undefined)
            );
        });
    });
}

// X-Air fader and send levels (0..1) to dB, the X32/X-Air fader law.
export function levelToDb(f: number): number {
    if (f <= 0) return -Infinity;
    if (f >= 0.5) return f * 40 - 30;
    if (f >= 0.25) return f * 80 - 50;
    if (f >= 0.0625) return f * 160 - 70;
    return f * 480 - 90;
}

// An OSC message with string/int arguments.
function encodeMessage(address: string, args: (string | number)[]): Buffer {
    const tags = `,${args
        .map((a) => (typeof a === 'string' ? 's' : 'i'))
        .join('')}`;
    const parts = [
        pad4(Buffer.from(address, 'ascii')),
        pad4(Buffer.from(tags, 'ascii')),
    ];
    args.forEach((a) => {
        if (typeof a === 'string') parts.push(pad4(Buffer.from(a, 'ascii')));
        else {
            const b = Buffer.alloc(4);
            b.writeInt32BE(a);
            parts.push(b);
        }
    });
    return Buffer.concat(parts);
}

// Live input meters (/meters/1): 16 channels, then aux return L/R and the
// four FX returns L/R, and more, in dBFS (int16 / 256). The subscription
// lapses after 10 s, so it is renewed every 9 s while running.
export class XairMeters {
    private socket: dgram.Socket | null = null;

    private renew: ReturnType<typeof setInterval> | null = null;

    private host = '';

    // Latest meter values in dB, index as above; empty until data arrives.
    public latest: number[] = [];

    public lastAt = 0;

    public start(host: string) {
        if (this.socket && this.host === host) return;
        this.stop();
        this.host = host;
        const socket = dgram.createSocket('udp4');
        this.socket = socket;
        socket.on('message', (msg) => this.onMessage(msg));
        socket.on('error', () => this.stop());
        const subscribe = () =>
            socket.send(
                encodeMessage('/meters', ['/meters/1']),
                XAIR_PORT,
                host,
                () => undefined
            );
        socket.bind(0, subscribe);
        this.renew = setInterval(subscribe, 9000);
    }

    public stop() {
        if (this.renew) clearInterval(this.renew);
        this.renew = null;
        try {
            this.socket?.close();
        } catch {
            // already closed
        }
        this.socket = null;
    }

    private onMessage(msg: Buffer) {
        try {
            const [address, a] = readString(msg, 0);
            if (address !== '/meters/1') return;
            const [tags, b] = readString(msg, a);
            if (tags !== ',b') return;
            const size = msg.readInt32BE(b);
            const blob = msg.subarray(b + 4, b + 4 + size);
            const count = blob.readInt32LE(0);
            const values: number[] = [];
            for (let i = 0; i < count && 4 + i * 2 + 1 < blob.length; i += 1) {
                values.push(blob.readInt16LE(4 + i * 2) / 256);
            }
            this.latest = values;
            this.lastAt = Date.now();
        } catch {
            // a malformed packet is skipped
        }
    }
}
