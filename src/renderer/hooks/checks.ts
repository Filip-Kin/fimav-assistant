import { useEffect, useState } from 'react';
import { CheckResult } from '../../models/Checks';

// Live check results from the main process.
export default function useChecks(): CheckResult[] | null {
    const [checks, setChecks] = useState<CheckResult[] | null>(null);
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('checks:list', (list: CheckResult[]) =>
            setChecks(list)
        );
        ipcRenderer.sendMessage('checks:get', []);
        return off;
    }, []);
    return checks;
}

export const ignoreCheck = (id: string) =>
    window.electron?.ipcRenderer.sendMessage('checks:ignore', [id]);

export const unignoreCheck = (id: string) =>
    window.electron?.ipcRenderer.sendMessage('checks:unignore', [id]);

// Run a check's one-click fix; resolves once the main process has tried it.
export const fixCheck = (
    id: string
): Promise<{ ok: boolean; message?: string }> =>
    new Promise((resolve) => {
        const ipc = window.electron?.ipcRenderer;
        if (!ipc) {
            resolve({ ok: false });
            return;
        }
        const off = ipc.on(
            'checks:fixed',
            (r: { id: string; ok: boolean; message?: string }) => {
                if (r.id !== id) return;
                off();
                resolve(r);
            }
        );
        ipc.sendMessage('checks:fix', [id]);
    });
