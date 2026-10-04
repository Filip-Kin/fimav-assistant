import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Button,
    Card,
    Empty,
    Form,
    Input,
    InputNumber,
    Modal,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Typography,
    message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
    CheckCircleFilled,
    CloseCircleFilled,
    FolderOpenOutlined,
    ScissorOutlined,
} from '@ant-design/icons';
import { AutoAVStatus } from 'models/AutoAVStatus';
import { MatchRecord, MatchTeam } from 'models/MatchRecord';
import AddonControlRow from '../../components/AddonControlRow';
import './index.css';

const { Title, Text } = Typography;

const LEVEL_SHORT: Record<string, string> = {
    Qualification: 'Qual',
    Playoff: 'Playoff',
    Practice: 'Practice',
    'Match Test': 'Test',
};

function levelShort(level: string): string {
    return LEVEL_SHORT[level] ?? level;
}

function matchLabel(m: MatchRecord): string {
    const play = m.playNumber > 1 ? ` P${m.playNumber}` : '';
    return `${levelShort(m.level)} ${m.matchNumber}${play}`;
}

const STATUS_TAG: Record<
    MatchRecord['status'],
    { color: string; text: string }
> = {
    recording: { color: 'processing', text: 'Recording' },
    recorded: { color: 'success', text: 'Recorded' },
    error: { color: 'error', text: 'Error' },
};

// The uploader writes its own state into the record's upload object.
function isUploaded(m: MatchRecord): boolean {
    const up = m.upload as { status?: string } | undefined;
    return up?.status === 'uploaded';
}

// Merge an incoming record into the list (replace by id), newest first.
function mergeMatch(list: MatchRecord[], rec: MatchRecord): MatchRecord[] {
    const next = list.filter((m) => m.id !== rec.id);
    next.push(rec);
    return next.sort((a, b) => b.startedAt - a.startedAt);
}

function CutCell({ record }: { record: MatchRecord }) {
    const triggerCut = () =>
        window.electron?.ipcRenderer.sendMessage('autoav:cutMatch', [
            record.saveFolder,
            record.id,
        ]);
    const reveal = (target?: string) =>
        window.electron?.ipcRenderer.sendMessage('autoav:revealFile', [target]);

    // Only recorded matches with a file can be cut.
    if (record.status !== 'recorded' || !record.filePath) {
        return <Text type="secondary">-</Text>;
    }

    // Carded matches are never cut: the card explanation lives in the dead time.
    if (record.hasCard) {
        return (
            <span title="Card issued, kept whole to preserve the explanation">
                <Tag color="gold">Kept (card)</Tag>
            </span>
        );
    }

    const p = record.processing;
    if (p?.state === 'queued') {
        return <Tag>Queued</Tag>;
    }
    if (p?.state === 'processing') {
        return <Tag color="processing">Cutting</Tag>;
    }
    if (p?.state === 'done') {
        return (
            <Button
                type="link"
                size="small"
                icon={<FolderOpenOutlined />}
                style={{ padding: 0, height: 'auto' }}
                title={p.outputPath ?? undefined}
                onClick={() => reveal(p.outputPath)}
            >
                Show cut
            </Button>
        );
    }
    if (p?.state === 'error') {
        return (
            <Space size={8}>
                <span title={p.error ?? undefined}>
                    <Tag color="error">Failed</Tag>
                </span>
                <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={triggerCut}
                >
                    Retry
                </Button>
            </Space>
        );
    }
    // Not cut yet: offer the manual trigger.
    return (
        <Button
            type="link"
            size="small"
            icon={<ScissorOutlined />}
            style={{ padding: 0, height: 'auto' }}
            onClick={triggerCut}
        >
            Cut
        </Button>
    );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
    return (
        <Space size={6}>
            {ok ? (
                <CheckCircleFilled style={{ color: '#52c41a' }} />
            ) : (
                <CloseCircleFilled style={{ color: '#ff4d4f' }} />
            )}
            <Text>{label}</Text>
        </Space>
    );
}

function RecordingBadge({ recording }: { recording: boolean }) {
    return (
        <Space size={6}>
            <span
                className={`rec-dot ${
                    recording ? 'rec-dot--live' : 'rec-dot--idle'
                }`}
            />
            <Text>vMix recording</Text>
        </Space>
    );
}

function TeamCell({ teams }: { teams: MatchRecord['teams'] }) {
    if (!teams || (teams.red.length === 0 && teams.blue.length === 0)) {
        return <Text type="secondary">-</Text>;
    }
    const renderTrio = (trio: MatchTeam[], className: string) => (
        <div className={className}>
            {trio.map((t) => (
                <span
                    key={t.teamNumber}
                    className={t.card !== 'None' ? 'team-carded' : undefined}
                >
                    {t.teamNumber}
                </span>
            ))}
        </div>
    );
    return (
        <div className="team-cell">
            {renderTrio(teams.red, 'team-trio team-trio--red')}
            {renderTrio(teams.blue, 'team-trio team-trio--blue')}
        </div>
    );
}

interface AutoAvSettings {
    fileNameMode: 'in-season' | 'off-season';
    eventNameOverride: string;
    saveFolder: string;
    autoCut: boolean;
}

function SettingsDialog({
    open,
    onClose,
    offSeason,
    modeForced,
    ftc,
}: {
    open: boolean;
    onClose: () => void;
    offSeason: boolean;
    modeForced: boolean;
    ftc: boolean;
}) {
    const [form] = Form.useForm<AutoAvSettings>();
    const [loading, setLoading] = useState(true);
    // FTC recording length: FTC Live sends no match-end event, so a recording
    // runs this long after the match starts.
    const [matchSeconds, setMatchSeconds] = useState(158);
    const [tailSeconds, setTailSeconds] = useState(5);

    useEffect(() => {
        if (!open || !ftc || !window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'ftc:settings',
            (f: { matchSeconds: number; tailSeconds: number }) => {
                setMatchSeconds(f.matchSeconds);
                setTailSeconds(f.tailSeconds);
            }
        );
        ipcRenderer.sendMessage('ftc:getState', []);
        return off;
    }, [open, ftc]);

    // Load current settings whenever the dialog opens.
    useEffect(() => {
        if (!open || !window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        setLoading(true);
        const off = ipcRenderer.on('autoav:settings', (s: AutoAvSettings) => {
            form.setFieldsValue(s);
            setLoading(false);
        });
        ipcRenderer.sendMessage('autoav:getSettings', []);
        return off;
    }, [open, form]);

    const pickFolder = useCallback(() => {
        if (!window.electron) return;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('autoav:folderPicked', (folder: string) => {
            off();
            form.setFieldValue('saveFolder', folder);
        });
        ipcRenderer.sendMessage('autoav:pickFolder', []);
    }, [form]);

    const save = useCallback(async () => {
        const values = await form.validateFields();
        window.electron?.ipcRenderer.sendMessage('autoav:saveSettings', [
            values,
        ]);
        if (ftc) {
            window.electron?.ipcRenderer.sendMessage('ftc:saveSettings', [
                { matchSeconds, tailSeconds },
            ]);
        }
        message.success('Settings saved');
        onClose();
    }, [form, onClose, ftc, matchSeconds, tailSeconds]);

    return (
        <Modal
            title="Auto AV settings"
            open={open}
            onCancel={onClose}
            onOk={save}
            okText="Save"
            confirmLoading={loading}
            destroyOnClose
        >
            <Form
                form={form}
                layout="vertical"
                disabled={loading}
                style={{ marginTop: 12 }}
            >
                <Form.Item
                    label="Event name"
                    name="eventNameOverride"
                    tooltip="Typed here, this always overrides the event name FMS reports and is used in the file name and folder. Leave blank to use FMS."
                >
                    <Input placeholder="e.g. Wolverine Robotics Competition" />
                </Form.Item>

                <Form.Item
                    label="Save folder"
                    name="saveFolder"
                    tooltip="Where renamed match videos are moved. Blank = alongside the vMix recording. A per-event subfolder is created inside this."
                >
                    <Input
                        placeholder="(blank = next to the vMix recording)"
                        addonAfter={
                            <Button
                                type="text"
                                size="small"
                                icon={<FolderOpenOutlined />}
                                onClick={pickFolder}
                                style={{ height: 'auto', padding: 0 }}
                            >
                                Browse
                            </Button>
                        }
                    />
                </Form.Item>

                <Form.Item
                    label="File naming style"
                    name="fileNameMode"
                    hidden={modeForced}
                    tooltip="Official events force in-season naming automatically; this is the fallback. In-season: QM13_Event.mp4. Off-season: 2026 Event - Qualification Match 13.mp4."
                >
                    <Select
                        options={[
                            {
                                value: 'in-season',
                                label: 'In-season (short codes)',
                            },
                            {
                                value: 'off-season',
                                label: 'Off-season (readable)',
                            },
                        ]}
                    />
                </Form.Item>

                <Form.Item
                    label="Auto-cut dead time"
                    name="autoCut"
                    valuePropName="checked"
                    hidden={!offSeason}
                    tooltip="After each match records, remove the dead time and keep the trimmed video in the event folder; the raw original is moved into an Originals subfolder. Matches with a card are always kept whole so the card explanation survives. Re-encodes on this machine, so leave off if vMix needs all the CPU during the event."
                >
                    <Switch />
                </Form.Item>

                {ftc && (
                    <Space size={16}>
                        <Form.Item label="Match length">
                            <InputNumber
                                min={1}
                                addonAfter="s"
                                value={matchSeconds}
                                onChange={(v) => setMatchSeconds(v ?? 158)}
                            />
                        </Form.Item>
                        <Form.Item label="Recording tail">
                            <InputNumber
                                min={0}
                                addonAfter="s"
                                value={tailSeconds}
                                onChange={(v) => setTailSeconds(v ?? 5)}
                            />
                        </Form.Item>
                    </Space>
                )}
            </Form>
        </Modal>
    );
}

export default function AutoAVPage() {
    const [status, setStatus] = useState<AutoAVStatus | null>(null);
    const [matches, setMatches] = useState<MatchRecord[]>([]);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [addonBusy, setAddonBusy] = useState(false);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;

        const offStatus = ipcRenderer.on('autoav:status', (s: AutoAVStatus) => {
            setStatus(s);
            setAddonBusy(false);
        });
        const offMatches = ipcRenderer.on(
            'autoav:matches',
            (list: MatchRecord[]) =>
                setMatches([...list].sort((a, b) => b.startedAt - a.startedAt))
        );
        const offMatch = ipcRenderer.on('autoav:match', (rec: MatchRecord) =>
            setMatches((prev) => mergeMatch(prev, rec))
        );

        ipcRenderer.sendMessage('autoav:getState', []);

        return () => {
            offStatus();
            offMatches();
            offMatch();
        };
    }, []);

    const recordingMatch = useMemo(
        () => matches.find((m) => m.status === 'recording'),
        [matches]
    );

    const restartAddon = useCallback(() => {
        setAddonBusy(true);
        window.electron?.ipcRenderer.sendMessage('autoav:restart', []);
    }, []);

    const stopAddon = useCallback(() => {
        setAddonBusy(true);
        window.electron?.ipcRenderer.sendMessage('autoav:stopAddon', []);
    }, []);

    const ftc = status?.program === 'ftc';
    // The field source for this program: FTC Live's scorekeeper or FRC's FMS.
    const fieldConnected = ftc
        ? !!status?.ftcConnected
        : !!status?.fmsConnected;
    const working = fieldConnected && !!status?.vmix.reachable;
    // Dead-time cutting (and its settings switch) is FRC off-season only.
    const offSeason = !ftc && status?.fileNameMode === 'off-season';

    const columns: ColumnsType<MatchRecord> = [
        {
            title: 'Match',
            key: 'match',
            render: (_, m) => <Text strong>{matchLabel(m)}</Text>,
        },
        {
            title: 'Teams (Red / Blue)',
            key: 'teams',
            render: (_, m) => <TeamCell teams={m.teams} />,
        },
        {
            title: 'File',
            key: 'file',
            render: (_, m) =>
                m.fileName ? (
                    <Text className="file-name" title={m.filePath ?? undefined}>
                        {m.fileName}
                    </Text>
                ) : (
                    <Text type="secondary">-</Text>
                ),
        },
        {
            title: 'Time',
            key: 'time',
            render: (_, m) => (
                <Text type="secondary">
                    {new Date(m.startedAt).toLocaleTimeString()}
                </Text>
            ),
        },
        {
            title: 'Status',
            key: 'status',
            render: (_, m) => {
                if (isUploaded(m)) {
                    return <Tag color="success">Uploaded</Tag>;
                }
                const tag = STATUS_TAG[m.status] ?? {
                    color: 'default',
                    text: m.status ?? 'Unknown',
                };
                return (
                    <span title={m.error ?? undefined}>
                        <Tag color={tag.color}>{tag.text}</Tag>
                    </span>
                );
            },
        },
    ];
    // Dead-time cutting is an off-season feature.
    if (offSeason) {
        columns.push({
            title: 'Cut',
            key: 'cut',
            render: (_, m) => <CutCell record={m} />,
        });
    }

    let statusLabel = 'Stopped';
    if (working) statusLabel = 'Working';
    else if (status?.running) statusLabel = 'Running';

    return (
        <>
            <AddonControlRow
                running={!!status?.running}
                statusLabel={statusLabel}
                onStart={restartAddon}
                onRestart={restartAddon}
                onStop={stopAddon}
                onSettings={() => setSettingsOpen(true)}
                busy={addonBusy}
            />
            <div className="autoav-page">
                <div className="autoav-cards">
                    <Card size="small" title="Status">
                        <Space direction="vertical" size={8}>
                            <StatusBadge
                                ok={fieldConnected}
                                label={
                                    ftc
                                        ? 'FTC Scorekeeper connected'
                                        : 'FMS connected'
                                }
                            />
                            <StatusBadge
                                ok={!!status?.vmix.reachable}
                                label="vMix reachable"
                            />
                            <RecordingBadge
                                recording={!!status?.vmix.recording}
                            />
                            {recordingMatch && (
                                <Text type="warning">
                                    Recording now: {matchLabel(recordingMatch)}
                                </Text>
                            )}
                        </Space>
                    </Card>

                    <Card size="small" title="Recording settings">
                        <Space direction="vertical" size={8}>
                            <Text strong>
                                {status?.currentEvent?.name ??
                                    'No event detected'}
                            </Text>
                            <Text
                                type="secondary"
                                className="file-name"
                                title={status?.sampleFileName || undefined}
                            >
                                {status?.sampleFileName
                                    ? `Filename: ${status.sampleFileName}`
                                    : 'Filename: -'}
                            </Text>
                            <Space size={6} align="start">
                                <Button
                                    type="text"
                                    size="small"
                                    icon={<FolderOpenOutlined />}
                                    onClick={() => {
                                        if (status?.saveFolder) {
                                            window.electron?.ipcRenderer.sendMessage(
                                                'autoav:openFolder',
                                                []
                                            );
                                        } else {
                                            setSettingsOpen(true);
                                        }
                                    }}
                                    style={{ padding: 0, height: 'auto' }}
                                />
                                <Text
                                    type="secondary"
                                    className="file-name"
                                    title={status?.saveFolder ?? undefined}
                                >
                                    {status?.saveFolder ??
                                        'Set a save folder in Settings, or it appears here after the first recorded match'}
                                </Text>
                            </Space>
                        </Space>
                    </Card>
                </div>

                <Title level={5} style={{ margin: '16px 0 8px' }}>
                    Recorded matches ({matches.length})
                </Title>

                {matches.length === 0 ? (
                    <Empty description="No matches recorded yet" />
                ) : (
                    <Table
                        rowKey="id"
                        size="small"
                        pagination={false}
                        columns={columns}
                        dataSource={matches}
                    />
                )}
            </div>
            <SettingsDialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                offSeason={offSeason}
                modeForced={!!status?.fileNameModeForced}
                ftc={ftc}
            />
        </>
    );
}
