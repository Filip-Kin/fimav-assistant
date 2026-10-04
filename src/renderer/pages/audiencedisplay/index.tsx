import { useCallback, useEffect, useState } from 'react';
import { Empty, Modal, message } from 'antd';
import AddonControlRow from '../../components/AddonControlRow';
import './index.css';

interface AudienceDisplayStatus {
    running: boolean;
    version: string;
}

// The display's own operator page (profile, vMix setup, playoff config).
const PAGE_URL = 'http://127.0.0.1:3001/';

export default function AudienceDisplayPage() {
    const [status, setStatus] = useState<AudienceDisplayStatus | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'audienceDisplay:status',
            (s: AudienceDisplayStatus) => {
                setStatus(s);
                setBusy(false);
            }
        );
        const poll = () =>
            ipcRenderer.sendMessage('audienceDisplay:getStatus', []);
        poll();
        const timer = setInterval(poll, 3000);
        return () => {
            off();
            clearInterval(timer);
        };
    }, []);

    const restart = useCallback(() => {
        setBusy(true);
        window.electron?.ipcRenderer.sendMessage('audienceDisplay:restart', []);
    }, []);

    const stop = useCallback(() => {
        setBusy(true);
        window.electron?.ipcRenderer.sendMessage('audienceDisplay:stop', []);
    }, []);

    // Version click: check for updates; toast if latest, confirm if not.
    const checkUpdate = useCallback(() => {
        if (!window.electron) return;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'audienceDisplay:updateInfo',
            (info: {
                current: string;
                latest: string;
                updateAvailable: boolean;
            }) => {
                off();
                if (!info.updateAvailable) {
                    message.success(`Up to date (v${info.current})`);
                    return;
                }
                Modal.confirm({
                    title: `Update to v${info.latest}`,
                    content: `v${info.current} → v${info.latest}. The display restarts.`,
                    okText: 'Update',
                    cancelText: 'Not now',
                    onOk: () => {
                        setBusy(true);
                        ipcRenderer.sendMessage('audienceDisplay:update', []);
                    },
                });
            }
        );
        ipcRenderer.sendMessage('audienceDisplay:checkUpdate', []);
    }, []);

    const running = !!status?.running;

    return (
        <div className="ad-page">
            <AddonControlRow
                running={running}
                version={status?.version}
                onVersionClick={checkUpdate}
                versionTooltip="Check for updates"
                onStart={restart}
                onRestart={restart}
                onStop={stop}
                busy={busy}
            />
            <div className="ad-frame">
                {running ? (
                    <iframe title="Audience display" src={PAGE_URL} />
                ) : (
                    <Empty description="Stopped" style={{ marginTop: 64 }} />
                )}
            </div>
        </div>
    );
}
