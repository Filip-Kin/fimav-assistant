import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Button,
    Empty,
    Form,
    Input,
    Modal,
    Popconfirm,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Typography,
    message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, YoutubeFilled } from '@ant-design/icons';
import AddonControlRow from '../../components/AddonControlRow';
import './index.css';

// Filename portion of a Windows or POSIX path (renderer has no node path).
function baseName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

const { Text, Link } = Typography;

const UPLOAD_BASE = 'http://localhost:8807';

// The uploader's per-video state machine, projected from the shared database.
export interface UploadVideoMeta {
    tba_match_key?: string;
    match_level?: string;
    match_number?: number;
    match_label?: string;
    play?: number;
}

export interface UploadVideo {
    status: string;
    yt_video_id?: string;
    title_used?: string;
    uploaded_at?: string;
    attempts?: number;
    last_error?: string;
    warnings?: string[];
    hold_reason?: string;
    changed_after_upload?: boolean;
    meta?: UploadVideoMeta;
    tba_submitted?: boolean;
    tba_submit_error?: string;
}

export interface UploadRow extends UploadVideo {
    filename: string;
}

export interface Playlist {
    id: string;
    title: string;
}

export interface UploadSettings {
    tbaAuthId: string;
    tbaSecret: string;
    autoSubmitTba: boolean;
    playlistId: string;
    playlistName: string;
    titleTemplate: string;
    descriptionTemplate: string;
    thumbnailPath: string;
    headless: boolean;
    visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
}

export interface SignInStatus {
    signedIn: boolean;
    channelName: string;
}

// Uploader status vocabulary → a display tag. "stable" is the uploader's
// "queued to upload" state.
const STATUS_TAG: Record<string, { color: string; text: string }> = {
    new: { color: 'default', text: 'New' },
    cutting: { color: 'processing', text: 'Cutting' },
    stable: { color: 'blue', text: 'Queued' },
    uploading: { color: 'processing', text: 'Uploading' },
    uploaded: { color: 'success', text: 'Uploaded' },
    failed: { color: 'error', text: 'Failed' },
    skipped: { color: 'default', text: 'Skipped' },
};

export function UploadStatusTag({ video }: { video: UploadRow }) {
    const tag = STATUS_TAG[video.status] ?? {
        color: 'default',
        text: video.status || 'Unknown',
    };
    const title = video.last_error || video.hold_reason || undefined;
    return (
        <span title={title}>
            <Tag color={tag.color}>{tag.text}</Tag>
        </span>
    );
}

function ytUrl(video: UploadRow): string | null {
    return video.yt_video_id
        ? `https://www.youtube.com/watch?v=${video.yt_video_id}`
        : null;
}

function matchLabel(video: UploadRow): string {
    return video.meta?.match_label ?? video.filename;
}

// A pure table of upload rows. Kept free of window.electron so the preview
// harness can render it with mock data under the real theme.
export function UploadTable({
    rows,
    onRetry,
    onSubmitTba,
}: {
    rows: UploadRow[];
    onRetry?: (_filename: string) => void;
    onSubmitTba?: (_filename: string) => void;
}) {
    const columns: ColumnsType<UploadRow> = [
        {
            title: 'Match',
            key: 'match',
            render: (_, v) => <Text strong>{matchLabel(v)}</Text>,
        },
        {
            title: 'Status',
            key: 'status',
            render: (_, v) => <UploadStatusTag video={v} />,
        },
        {
            title: 'YouTube',
            key: 'youtube',
            render: (_, v) => {
                const url = ytUrl(v);
                if (!url) return <Text type="secondary">-</Text>;
                return (
                    <Link href={url} target="_blank">
                        <Space size={4}>
                            <YoutubeFilled style={{ color: '#ff0000' }} />
                            YouTube
                        </Space>
                    </Link>
                );
            },
        },
        {
            title: 'TBA',
            key: 'tba',
            render: (_, v) => {
                if (v.tba_submitted) {
                    return <Tag color="success">Submitted</Tag>;
                }
                if (v.tba_submit_error) {
                    return (
                        <Space size={8}>
                            <span title={v.tba_submit_error}>
                                <Tag color="error">Error</Tag>
                            </span>
                            {onSubmitTba && (
                                <Button
                                    type="link"
                                    size="small"
                                    style={{ padding: 0, height: 'auto' }}
                                    onClick={() => onSubmitTba(v.filename)}
                                >
                                    Retry
                                </Button>
                            )}
                        </Space>
                    );
                }
                if (v.status === 'uploaded' && onSubmitTba) {
                    return (
                        <Button
                            type="link"
                            size="small"
                            style={{ padding: 0, height: 'auto' }}
                            onClick={() => onSubmitTba(v.filename)}
                        >
                            Submit
                        </Button>
                    );
                }
                return <Text type="secondary">-</Text>;
            },
        },
        {
            title: '',
            key: 'action',
            render: (_, v) =>
                v.status === 'failed' && onRetry ? (
                    <Button
                        type="link"
                        size="small"
                        style={{ padding: 0, height: 'auto' }}
                        onClick={() => onRetry(v.filename)}
                    >
                        Retry
                    </Button>
                ) : null,
        },
    ];

    if (rows.length === 0) {
        return <Empty description="No videos" />;
    }
    return (
        <Table
            rowKey="filename"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={rows}
        />
    );
}

UploadTable.defaultProps = {
    onRetry: undefined,
    onSubmitTba: undefined,
};

const VISIBILITY_OPTIONS = [
    { value: 'PUBLIC', label: 'Public' },
    { value: 'UNLISTED', label: 'Unlisted' },
    { value: 'PRIVATE', label: 'Private' },
];

// The account row: sign-in status and the sign-in / log-out actions. Log out
// deletes the saved login, so it is guarded by a confirm.
function AccountRow({
    signIn,
    signingIn,
    onSignIn,
    onOpenChannel,
    onLogout,
}: {
    signIn: SignInStatus;
    signingIn: boolean;
    onSignIn: () => void;
    onOpenChannel: () => void;
    onLogout: () => void;
}) {
    return (
        <div className="upload-account">
            <Space size={8} align="center">
                <span
                    className={`addon-dot ${
                        signIn.signedIn ? 'addon-dot--on' : 'addon-dot--off'
                    }`}
                />
                <Text>
                    {signIn.signedIn
                        ? `Signed in as ${signIn.channelName || 'YouTube'}`
                        : 'Not signed in'}
                </Text>
            </Space>
            <Space size={8}>
                <Button
                    size="small"
                    onClick={onSignIn}
                    loading={signingIn}
                    disabled={signIn.signedIn || signingIn}
                >
                    Sign in to YouTube
                </Button>
                <Button
                    size="small"
                    onClick={onOpenChannel}
                    disabled={!signIn.signedIn}
                >
                    Open channel
                </Button>
                <Popconfirm
                    title="Log out of YouTube?"
                    okText="Log out"
                    cancelText="Cancel"
                    onConfirm={onLogout}
                >
                    <Button size="small" danger disabled={!signIn.signedIn}>
                        Log out of YouTube
                    </Button>
                </Popconfirm>
            </Space>
        </div>
    );
}

// Settings dialog. Exported so the preview can render it open.
export function UploadSettingsDialog({
    open,
    onClose,
    playlists,
    playlistsLoading,
    signIn,
    signingIn,
    onSignIn,
    onOpenChannel,
    onLogout,
    onRefreshPlaylists,
}: {
    open: boolean;
    onClose: () => void;
    playlists: Playlist[];
    playlistsLoading: boolean;
    signIn: SignInStatus;
    signingIn: boolean;
    onSignIn: () => void;
    onOpenChannel: () => void;
    onLogout: () => void;
    onRefreshPlaylists: () => void;
}) {
    const [form] = Form.useForm<UploadSettings>();
    const [loading, setLoading] = useState(true);
    const [thumbnail, setThumbnail] = useState('');

    useEffect(() => {
        if (!open || !window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        setLoading(true);
        const offSettings = ipcRenderer.on(
            'upload:settings',
            (s: UploadSettings) => {
                form.setFieldsValue(s);
                setThumbnail(s.thumbnailPath ?? '');
                setLoading(false);
            }
        );
        const offThumb = ipcRenderer.on(
            'upload:thumbnailPicked',
            (p: string) => {
                setThumbnail(p);
                form.setFieldValue('thumbnailPath', p);
            }
        );
        ipcRenderer.sendMessage('upload:getSettings', []);
        return () => {
            offSettings();
            offThumb();
        };
    }, [open, form]);

    const pickThumbnail = useCallback(() => {
        window.electron?.ipcRenderer.sendMessage('upload:pickThumbnail', []);
    }, []);

    const save = useCallback(async () => {
        const values = await form.validateFields();
        const picked = playlists.find((p) => p.id === values.playlistId);
        window.electron?.ipcRenderer.sendMessage('upload:saveSettings', [
            { ...values, playlistName: picked?.title ?? values.playlistName },
        ]);
        message.success('Saved');
        onClose();
    }, [form, onClose, playlists]);

    return (
        <Modal
            title="Upload settings"
            open={open}
            onCancel={onClose}
            onOk={save}
            okText="Save"
            confirmLoading={loading}
            width={560}
            destroyOnClose
        >
            <AccountRow
                signIn={signIn}
                signingIn={signingIn}
                onSignIn={onSignIn}
                onOpenChannel={onOpenChannel}
                onLogout={onLogout}
            />
            <Form
                form={form}
                layout="vertical"
                disabled={loading}
                style={{ marginTop: 12 }}
            >
                <Form.Item label="Playlist">
                    <Space.Compact style={{ width: '100%' }}>
                        <Form.Item name="playlistId" noStyle>
                            <Select
                                allowClear
                                placeholder="Playlist"
                                options={playlists.map((p) => ({
                                    value: p.id,
                                    label: p.title,
                                }))}
                            />
                        </Form.Item>
                        <Button
                            icon={<ReloadOutlined />}
                            onClick={onRefreshPlaylists}
                            loading={playlistsLoading}
                            disabled={!signIn.signedIn}
                        />
                    </Space.Compact>
                </Form.Item>
                <Form.Item label="Visibility" name="visibility">
                    <Select options={VISIBILITY_OPTIONS} />
                </Form.Item>
                <Form.Item label="Thumbnail">
                    <Space size={8} align="center">
                        <Button onClick={pickThumbnail}>Choose</Button>
                        <Text
                            type="secondary"
                            className="file-name"
                            title={thumbnail || undefined}
                        >
                            {thumbnail ? baseName(thumbnail) : 'None'}
                        </Text>
                    </Space>
                    <Form.Item name="thumbnailPath" hidden>
                        <Input />
                    </Form.Item>
                </Form.Item>
                <Form.Item label="Title template" name="titleTemplate">
                    <Input />
                </Form.Item>
                <Form.Item
                    label="Description template"
                    name="descriptionTemplate"
                >
                    <Input.TextArea autoSize={{ minRows: 8, maxRows: 14 }} />
                </Form.Item>
                <Form.Item label="TBA auth ID" name="tbaAuthId">
                    <Input />
                </Form.Item>
                <Form.Item label="TBA secret" name="tbaSecret">
                    <Input.Password />
                </Form.Item>
                <Form.Item
                    label="Auto-submit to TBA"
                    name="autoSubmitTba"
                    valuePropName="checked"
                >
                    <Switch />
                </Form.Item>
                <Form.Item
                    label="Headless"
                    name="headless"
                    valuePropName="checked"
                >
                    <Switch />
                </Form.Item>
            </Form>
        </Modal>
    );
}

interface UploadAddonStatus {
    running: boolean;
    version: string;
    eventKey: string;
}

function sortRows(videos: Record<string, UploadVideo>): UploadRow[] {
    return Object.entries(videos)
        .map(([filename, v]) => ({ filename, ...v }))
        .sort(
            (a, b) =>
                (a.meta?.match_number ?? Number.MAX_SAFE_INTEGER) -
                (b.meta?.match_number ?? Number.MAX_SAFE_INTEGER)
        );
}

export default function UploadPage() {
    const [status, setStatus] = useState<UploadAddonStatus | null>(null);
    const [rows, setRows] = useState<UploadRow[]>([]);
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [signIn, setSignIn] = useState<SignInStatus>({
        signedIn: false,
        channelName: '',
    });
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [signingIn, setSigningIn] = useState(false);
    const [playlistsLoading, setPlaylistsLoading] = useState(false);

    const eventKey = status?.eventKey ?? '';

    // Addon status over IPC (polled while mounted).
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'upload:status',
            (s: UploadAddonStatus) => {
                setStatus(s);
                setBusy(false);
            }
        );
        const poll = () => ipcRenderer.sendMessage('upload:getStatus', []);
        poll();
        const timer = setInterval(poll, 3000);
        return () => {
            off();
            clearInterval(timer);
        };
    }, []);

    // Match/upload state straight from the uploader (permissive CORS), polled.
    const running = !!status?.running;
    useEffect(() => {
        if (!running) return undefined;
        let cancelled = false;
        const load = async () => {
            try {
                const res = await fetch(
                    `${UPLOAD_BASE}/api/upload/state?event_key=${encodeURIComponent(
                        eventKey
                    )}`,
                    { signal: AbortSignal.timeout(4000) }
                );
                const body = await res.json();
                if (!cancelled) setRows(sortRows(body?.videos ?? {}));
            } catch {
                // uploader not answering yet
            }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [running, eventKey]);

    // Sign-in status straight from the uploader's health endpoint, polled.
    useEffect(() => {
        if (!running) return undefined;
        let cancelled = false;
        const load = async () => {
            try {
                const res = await fetch(`${UPLOAD_BASE}/api/health`, {
                    signal: AbortSignal.timeout(3000),
                });
                const body = await res.json();
                if (!cancelled) {
                    setSignIn({
                        signedIn: !!body?.signed_in,
                        channelName: body?.channel_name ?? '',
                    });
                }
            } catch {
                // uploader not answering yet
            }
        };
        load();
        const timer = setInterval(load, 4000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [running]);

    const loadPlaylists = useCallback(
        (refresh: boolean) => {
            // A refresh drives a Chrome scrape of the Studio playlists page, which
            // is slow, so give it a long timeout; the cached read is instant.
            if (refresh) setPlaylistsLoading(true);
            fetch(
                `${UPLOAD_BASE}/api/yt/playlists?event_key=${encodeURIComponent(
                    eventKey
                )}${refresh ? '&refresh=1' : ''}`,
                { signal: AbortSignal.timeout(refresh ? 45000 : 8000) }
            )
                .then((r) => r.json())
                .then((list) => {
                    if (Array.isArray(list)) {
                        setPlaylists(list);
                    } else if (list?.error) {
                        // Keep the current list rather than blanking it.
                        message.error(`Playlists: ${list.error}`);
                    }
                    setPlaylistsLoading(false);
                    return null;
                })
                .catch(() => {
                    setPlaylistsLoading(false);
                    if (refresh) message.error('Playlist refresh failed');
                });
        },
        [eventKey]
    );

    // Playlists for the settings dropdown (fetched when settings opens).
    useEffect(() => {
        if (!settingsOpen || !running) return;
        loadPlaylists(false);
    }, [settingsOpen, running, loadPlaylists]);

    const signInYouTube = useCallback(() => {
        setSigningIn(true);
        fetch(
            `${UPLOAD_BASE}/api/upload/login?event_key=${encodeURIComponent(
                eventKey
            )}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ event_key: eventKey }),
                signal: AbortSignal.timeout(5000),
            }
        )
            .then(() => message.info('Opening YouTube sign-in'))
            .catch(() => {
                setSigningIn(false);
                message.error('Failed');
            });
    }, [eventKey]);

    // The sign-in window closes itself once sign-in lands; the health poll flips
    // signedIn, which clears the button's in-progress state.
    useEffect(() => {
        if (signIn.signedIn) setSigningIn(false);
    }, [signIn.signedIn]);

    const openChannel = useCallback(() => {
        fetch(
            `${UPLOAD_BASE}/api/upload/open-channel?event_key=${encodeURIComponent(
                eventKey
            )}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ event_key: eventKey }),
                signal: AbortSignal.timeout(5000),
            }
        )
            .then(() => message.info('Opening channel'))
            .catch(() => message.error('Failed'));
    }, [eventKey]);

    const logoutYouTube = useCallback(() => {
        fetch(
            `${UPLOAD_BASE}/api/upload/logout?event_key=${encodeURIComponent(
                eventKey
            )}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ event_key: eventKey }),
                signal: AbortSignal.timeout(5000),
            }
        )
            .then(() => {
                setSignIn({ signedIn: false, channelName: '' });
                message.success('Logged out');
                return null;
            })
            .catch(() => message.error('Failed'));
    }, [eventKey]);

    const restart = useCallback(() => {
        setBusy(true);
        window.electron?.ipcRenderer.sendMessage('upload:restart', []);
    }, []);

    const stop = useCallback(() => {
        setBusy(true);
        window.electron?.ipcRenderer.sendMessage('upload:stopAddon', []);
    }, []);

    const post = useCallback(
        async (route: string, filename: string, ok: string) => {
            try {
                await fetch(
                    `${UPLOAD_BASE}${route}?event_key=${encodeURIComponent(
                        eventKey
                    )}`,
                    {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ filename }),
                        signal: AbortSignal.timeout(5000),
                    }
                );
                message.success(ok);
            } catch {
                message.error('Failed');
            }
        },
        [eventKey]
    );

    const onRetry = useCallback(
        (filename: string) => post('/api/upload/retry', filename, 'Retrying'),
        [post]
    );
    const onSubmitTba = useCallback(
        (filename: string) =>
            post('/api/yt/submit-tba', filename, 'Submitted'),
        [post]
    );

    const statusLabel = useMemo(() => {
        if (running) return 'Running';
        return 'Stopped';
    }, [running]);

    return (
        <>
            <AddonControlRow
                running={running}
                statusLabel={statusLabel}
                version={status?.version}
                onStart={restart}
                onRestart={restart}
                onStop={stop}
                onSettings={() => setSettingsOpen(true)}
                busy={busy}
            />
            <div className="upload-page">
                <Typography.Title level={5} style={{ margin: '0 0 8px' }}>
                    Uploads ({rows.length})
                </Typography.Title>
                <UploadTable
                    rows={rows}
                    onRetry={onRetry}
                    onSubmitTba={onSubmitTba}
                />
            </div>
            <UploadSettingsDialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                playlists={playlists}
                playlistsLoading={playlistsLoading}
                signIn={signIn}
                signingIn={signingIn}
                onSignIn={signInYouTube}
                onOpenChannel={openChannel}
                onLogout={logoutYouTube}
                onRefreshPlaylists={() => loadPlaylists(true)}
            />
        </>
    );
}
