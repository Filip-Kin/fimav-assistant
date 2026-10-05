// Stream and audio checks (src/main/checks/engine.ts), shared with the UI.
export type CheckState = 'ok' | 'warning' | 'critical' | 'unknown';

export interface CheckResult {
    id: string;
    group: 'Stream' | 'Audio' | 'Recording' | 'Captions';
    label: string;
    state: CheckState;
    detail: string;
    // Set while "Ignore 6 h" is in force for this check (epoch ms).
    ignoredUntil: number | null;
}

// Failing and not ignored: what the banner and the tab dot show.
export const isAlerting = (r: CheckResult) =>
    (r.state === 'warning' || r.state === 'critical') && !r.ignoredUntil;
