import { ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Badge } from 'antd';
import {
    BellOutlined,
    CloudUploadOutlined,
    MessageOutlined,
    RobotOutlined,
    SettingOutlined,
    VideoCameraOutlined,
} from '@ant-design/icons';
import AlertsResponse from 'models/AlertsResponse';
import { AutoAVStatus } from 'models/AutoAVStatus';
import './TabBar.css';

interface TabDef {
    key: string;
    label: string;
    icon: ReactNode;
    isActive: (_pathname: string) => boolean;
    // Shown only in off-season mode
    offSeasonOnly?: boolean;
}

const tabs: TabDef[] = [
    {
        key: '/',
        label: 'Setup',
        icon: <SettingOutlined />,
        isActive: (p) => p === '/' || p.startsWith('/step'),
    },
    {
        key: '/vmix',
        label: 'vMix',
        icon: <VideoCameraOutlined />,
        isActive: (p) => p.startsWith('/vmix'),
    },
    {
        key: '/livecaptions',
        label: 'Live Captions',
        icon: <MessageOutlined />,
        isActive: (p) => p.startsWith('/livecaptions'),
    },
    {
        key: '/autoav',
        label: 'Auto AV',
        icon: <RobotOutlined />,
        isActive: (p) => p.startsWith('/autoav'),
    },
    {
        key: '/upload',
        label: 'Upload',
        icon: <CloudUploadOutlined />,
        isActive: (p) => p.startsWith('/upload'),
        offSeasonOnly: true,
    },
];

export default function TabBar() {
    const nav = useNavigate();
    const { pathname } = useLocation();
    const [alertCount, setAlertCount] = useState(0);
    // null until AutoAV reports, so an off-season-only tab never flashes in.
    const [offSeason, setOffSeason] = useState<boolean | null>(null);

    // The season follows AutoAV's effective file naming mode.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('autoav:status', (s: AutoAVStatus) =>
            setOffSeason(s?.fileNameMode === 'off-season')
        );
        ipcRenderer.sendMessage('autoav:getState', []);
        return off;
    }, []);

    // Leave an off-season-only page once the event turns out to be in-season.
    useEffect(() => {
        if (offSeason !== false) return;
        if (tabs.some((t) => t.offSeasonOnly && t.isActive(pathname))) {
            nav('/autoav');
        }
    }, [offSeason, pathname, nav]);

    // Subscribe to alerts and poll so the bell reflects unread count.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('alerts:alerts', (resp: AlertsResponse) =>
            setAlertCount(resp?.alerts?.length ?? 0)
        );
        const poll = () => ipcRenderer.sendMessage('alerts:getAlerts', []);
        poll();
        const timer = setInterval(poll, 5000);
        return () => {
            off();
            clearInterval(timer);
        };
    }, []);

    const alertsActive = pathname.startsWith('/alerts');

    return (
        <div className="tab-bar">
            {tabs
                .filter((t) => !t.offSeasonOnly || offSeason === true)
                .map((t) => {
                    const active = t.isActive(pathname);
                    return (
                        <button
                            key={t.key}
                            type="button"
                            className={`tab-item${
                                active ? ' tab-item--active' : ''
                            }`}
                            onClick={() => nav(t.key)}
                        >
                            <span className="tab-icon">{t.icon}</span>
                            <span>{t.label}</span>
                        </button>
                    );
                })}

            <div className="tab-spacer" />

            <button
                type="button"
                title="Notifications"
                className={`tab-item tab-bell${
                    alertsActive ? ' tab-item--active' : ''
                }`}
                onClick={() => nav('/alerts')}
            >
                <Badge dot count={alertCount} offset={[2, -2]}>
                    <BellOutlined className="tab-icon" />
                </Badge>
            </button>
        </div>
    );
}
