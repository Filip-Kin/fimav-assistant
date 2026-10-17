// Behringer X-Air (XR12/16/18) parameter laws, no Node imports: used by
// the main process (checks/xair.ts) and the UI's on-screen fader.

// X-Air fader and send levels (0..1) to dB, the X32/X-Air fader law: four
// straight lines meeting at -60, -30 and -10 dB, 0.75 = 0 dB, 1.0 = +10 dB.
// From Behringer's X-Air Parameters.txt ("fader/level parameter: dblevel =
// 40 * idx / (steps - 1) - 30 if idx >= steps / 2 ...", float = idx /
// (steps - 1)), the same law as Maillot's X32 OSC protocol appendix.
export function levelToDb(f: number): number {
    if (f <= 0) return -Infinity;
    if (f >= 0.5) return f * 40 - 30;
    if (f >= 0.25) return f * 80 - 50;
    if (f >= 0.0625) return f * 160 - 70;
    return f * 480 - 90;
}

// Steps of a fader (channel, return, bus, LR) and of a send level.
export const FADER_STEPS = 1024;
export const LEVEL_STEPS = 161;

// Highest a fader or send goes.
export const MAX_DB = 10;

// Preamp gain (/headamp/NN/gain): -12..+60 dB, linear, 145 steps.
export const GAIN_MIN_DB = -12;
export const GAIN_MAX_DB = 60;
export const GAIN_STEPS = 145;

export const gainToLevel = (db: number) => {
    const f =
        (Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, db)) - GAIN_MIN_DB) /
        (GAIN_MAX_DB - GAIN_MIN_DB);
    return Math.round(f * (GAIN_STEPS - 1)) / (GAIN_STEPS - 1);
};

export const levelToGain = (f: number) =>
    GAIN_MIN_DB + f * (GAIN_MAX_DB - GAIN_MIN_DB);

// dB to the X-Air float, the inverse of levelToDb, rounded to the nearest
// step the mixer has (so the value read back is the value written).
// -Infinity (or under -90) is 0, off.
export function dbToLevel(db: number, steps: number): number {
    if (!(db > -90)) return 0;
    const d = Math.min(db, MAX_DB);
    let f: number;
    if (d < -60) f = (d + 90) / 480;
    else if (d < -30) f = (d + 70) / 160;
    else if (d < -10) f = (d + 50) / 80;
    else f = (d + 30) / 40;
    return Math.round(f * (steps - 1)) / (steps - 1);
}
