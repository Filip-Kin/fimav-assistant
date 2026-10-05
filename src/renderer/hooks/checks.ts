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
