import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AutoComplete,
    Button,
    Card,
    Empty,
    Form,
    Input,
    InputNumber,
    Modal,
    Popconfirm,
    Select,
    Space,
    Switch,
    Table,
    Tabs,
    Tag,
    Typography,
    message,
} from 'antd';
import {
    DeleteOutlined,
    ExportOutlined,
    PlusOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import AddonControlRow from '../../components/AddonControlRow';
import {
    ACTION_DEFS,
    ActionDef,
    CompanionAction,
    CompanionButton,
    CompanionLayout,
    CompanionPage,
    CustomAdConfig,
    CustomAdState,
    FMS_BITFOCUS_EVENTS,
    FmsAutomationConfig,
    matchActionDef,
} from '../../../models/Bitfocus';
import './index.css';

const { Text } = Typography;

interface BitfocusSettings {
    customAdUrl: string;
}

interface Result {
    op: string;
    ok: boolean;
    data?: any;
    error?: string;
}

const send = (channel: string, ...args: unknown[]) =>
    window.electron?.ipcRenderer.sendMessage(channel, args);

const defFor = (a: CompanionAction) =>
    a.hasExpression ? undefined : matchActionDef(a.definitionId, a.options);

// A button the editor can change: a normal button whose press actions are all
// in the catalog. Anything else is edited in Companion.
const isEditable = (b: CompanionButton | undefined) =>
    !b || (b.type === 'button-layered' && b.actions.every((a) => defFor(a)));

// Companion writes a line break in a label as the two characters "\\n".
const labelToText = (label: string) => label.replace(/\\n/g, '\n');
const textToLabel = (text: string) => text.replace(/\r?\n/g, '\\n');

// FMS commands that press the button at this location.
const commandsAt = (
    fms: FmsAutomationConfig | null,
    page: number,
    row: number,
    column: number
) =>
    (fms?.BitfocusCommands ?? []).filter(
        (c) => c.Page === page && c.Row === row && c.Column === column
    );

// Action picker options, one section per Companion connection.
interface ActionGroup {
    label: string;
    options: { value: string; label: string }[];
}

function actionGroups(
    defs: ActionDef[],
    layout: CompanionLayout | null
): ActionGroup[] {
    const groups: ActionGroup[] = [];
    defs.forEach((d) => {
        const label =
            d.module === 'internal'
                ? 'Companion'
                : layout?.connections.find((c) => c.module === d.module)
                      ?.label ?? d.module;
        let g = groups.find((x) => x.label === label);
        if (!g) {
            g = { label, options: [] };
            groups.push(g);
        }
        g.options.push({ value: d.key, label: d.label });
    });
    return groups;
}

// #region Button editor

interface EditAction {
    key: string; // ActionDef key
    options: Record<string, unknown>;
}

function ActionRow({
    action,
    groups,
    vmixInputs,
    onChange,
    onRemove,
}: {
    action: EditAction;
    groups: ActionGroup[];
    vmixInputs: string[];
    onChange: (_a: EditAction) => void;
    onRemove: () => void;
}) {
    const def = ACTION_DEFS.find((d) => d.key === action.key);
    const setOpt = (k: string, v: unknown) =>
        onChange({ ...action, options: { ...action.options, [k]: v } });
    return (
        <div className="bf-action">
            <Select
                style={{ width: 170, flex: 'none' }}
                showSearch
                optionFilterProp="label"
                popupMatchSelectWidth={220}
                value={action.key}
                options={groups}
                onChange={(key) => onChange({ key, options: {} })}
            />
            {def?.fields.map((f) => {
                const v = action.options[f.key];
                if (f.type === 'vmixInput') {
                    return (
                        <AutoComplete
                            key={f.key}
                            style={{ flex: 1, minWidth: 0 }}
                            // Red when vMix has no input by that name (only
                            // once vMix has answered with its inputs).
                            status={
                                v &&
                                vmixInputs.length > 0 &&
                                !vmixInputs.includes(v as string)
                                    ? 'error'
                                    : undefined
                            }
                            placeholder={f.label}
                            value={(v as string) ?? ''}
                            options={vmixInputs.map((i) => ({ value: i }))}
                            filterOption={(input, o) =>
                                String(o?.value ?? '')
                                    .toLowerCase()
                                    .includes(input.toLowerCase())
                            }
                            onChange={(x) => setOpt(f.key, x)}
                        />
                    );
                }
                if (f.type === 'select') {
                    return (
                        <Select
                            key={f.key}
                            style={{ width: 170, flex: 'none' }}
                            placeholder={f.label}
                            value={v as string | undefined}
                            options={f.options}
                            onChange={(x) => setOpt(f.key, x)}
                        />
                    );
                }
                return (
                    <InputNumber
                        key={f.key}
                        style={{ width: 170, flex: 'none' }}
                        placeholder={f.label}
                        addonAfter={f.suffix}
                        min={0}
                        value={v === undefined || v === '' ? null : Number(v)}
                        onChange={(x) =>
                            setOpt(f.key, f.asString ? String(x ?? '') : x)
                        }
                    />
                );
            })}
            <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={onRemove}
            />
        </div>
    );
}

function ButtonEditor({
    open,
    page,
    cell,
    button,
    layout,
    vmixInputs,
    fms,
    saving,
    onSave,
    onSaveTriggers,
    onClear,
    onClose,
}: {
    open: boolean;
    page: CompanionPage | undefined;
    cell: { row: number; column: number } | null;
    button: CompanionButton | undefined;
    layout: CompanionLayout | null;
    vmixInputs: string[];
    fms: FmsAutomationConfig | null;
    saving: boolean;
    onSave: (_text: string, _actions: EditAction[]) => void;
    onSaveTriggers: (_events: number[]) => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const [text, setText] = useState('');
    const [actions, setActions] = useState<EditAction[]>([]);
    const [events, setEvents] = useState<number[]>([]);

    const savedEvents = useMemo(
        () =>
            page && cell
                ? commandsAt(fms, page.number, cell.row, cell.column).map(
                      (c) => c.BfEvent
                  )
                : [],
        [fms, page, cell]
    );

    useEffect(() => {
        if (!open) return;
        setText(labelToText(button?.text ?? ''));
        setActions(
            (button?.actions ?? []).map((a) => ({
                key: defFor(a)?.key ?? a.definitionId,
                options: a.options,
            }))
        );
    }, [open, button]);

    useEffect(() => {
        if (open) setEvents(savedEvents);
    }, [open, savedEvents]);

    const triggersChanged =
        [...events].sort().join() !== [...savedEvents].sort().join();

    // The FMS part saves on its own, so a button only Companion can edit
    // still gets its FMS triggers.
    const save = () => {
        if (triggersChanged) onSaveTriggers(events);
        if (isEditable(button)) onSave(textToLabel(text), actions);
        else onClose();
    };

    const triggers = fms && (
        <Form.Item label="FMS">
            <Select
                mode="multiple"
                allowClear
                placeholder="Events"
                value={events}
                options={FMS_BITFOCUS_EVENTS}
                onChange={setEvents}
            />
        </Form.Item>
    );

    // Only actions whose module has a connection in this Companion.
    const defs = useMemo(
        () =>
            ACTION_DEFS.filter(
                (d) =>
                    d.module === 'internal' ||
                    layout?.connections.some((c) => c.module === d.module)
            ),
        [layout]
    );

    const groups = useMemo(() => actionGroups(defs, layout), [defs, layout]);

    const editable = isEditable(button);
    const title = `${page?.name ?? ''} ${
        cell ? `${cell.row}/${cell.column}` : ''
    }`;

    return (
        <Modal
            title={title}
            open={open}
            onCancel={onClose}
            width={760}
            destroyOnClose
            footer={
                editable ? (
                    <Space>
                        {button && (
                            <Popconfirm
                                title="Clear button"
                                onConfirm={onClear}
                            >
                                <Button danger disabled={saving}>
                                    Clear
                                </Button>
                            </Popconfirm>
                        )}
                        <Button onClick={onClose}>Cancel</Button>
                        <Button type="primary" loading={saving} onClick={save}>
                            Save
                        </Button>
                    </Space>
                ) : (
                    <Space>
                        <Button
                            icon={<ExportOutlined />}
                            onClick={() => send('bitfocus:openCompanion')}
                        >
                            Companion
                        </Button>
                        <Button onClick={onClose}>Cancel</Button>
                        {fms && (
                            <Button
                                type="primary"
                                loading={saving}
                                disabled={!triggersChanged}
                                onClick={save}
                            >
                                Save
                            </Button>
                        )}
                    </Space>
                )
            }
        >
            {editable ? (
                <Form layout="vertical">
                    <Form.Item label="Label">
                        <Input.TextArea
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />
                    </Form.Item>
                    <Form.Item label="Actions">
                        <div className="bf-actions">
                            {actions.map((a, i) => (
                                <ActionRow
                                    // eslint-disable-next-line react/no-array-index-key
                                    key={i}
                                    action={a}
                                    groups={groups}
                                    vmixInputs={vmixInputs}
                                    onChange={(next) =>
                                        setActions(
                                            actions.map((x, j) =>
                                                j === i ? next : x
                                            )
                                        )
                                    }
                                    onRemove={() =>
                                        setActions(
                                            actions.filter((_, j) => j !== i)
                                        )
                                    }
                                />
                            ))}
                            <Button
                                icon={<PlusOutlined />}
                                disabled={!defs.length}
                                onClick={() =>
                                    setActions([
                                        ...actions,
                                        { key: defs[0].key, options: {} },
                                    ])
                                }
                            >
                                Action
                            </Button>
                        </div>
                    </Form.Item>
                    {triggers}
                </Form>
            ) : (
                <Form layout="vertical">
                    <Tag color="gold">Companion only</Tag>
                    <div className="bf-readonly">
                        {(button?.actions ?? []).map((a) => (
                            <div key={a.id}>
                                <Text code>{a.definitionId}</Text>
                            </div>
                        ))}
                    </div>
                    {triggers}
                </Form>
            )}
        </Modal>
    );
}

// #endregion

// #region Button grid

function ButtonGrid({
    page,
    fms,
    onPick,
}: {
    page: CompanionPage;
    fms: FmsAutomationConfig | null;
    onPick: (_row: number, _column: number) => void;
}) {
    const cells = [];
    for (let r = 0; r < page.rows; r += 1) {
        for (let c = 0; c < page.columns; c += 1) {
            const b = page.buttons[`${r}/${c}`];
            cells.push(
                <button
                    type="button"
                    key={`${r}/${c}`}
                    className={`bf-cell${b ? ' bf-cell--set' : ''}${
                        b && !isEditable(b) ? ' bf-cell--locked' : ''
                    }${
                        commandsAt(fms, page.number, r, c).length
                            ? ' bf-cell--fms'
                            : ''
                    }`}
                    title={`${r}/${c}`}
                    onClick={() => onPick(r, c)}
                >
                    {b ? labelToText(b.text) || b.type : ''}
                </button>
            );
        }
    }
    return (
        <div
            className="bf-grid"
            style={{ gridTemplateColumns: `repeat(${page.columns}, 1fr)` }}
        >
            {cells}
        </div>
    );
}

// #endregion

// #region Triggers

const locationColumns = (
    onChange: (_i: number, _key: string, _v: number) => void
) =>
    ['Page', 'Row', 'Column'].map((label) => ({
        title: label,
        key: label,
        width: 110,
        render: (_: unknown, r: any, i: number) => (
            <InputNumber
                min={label === 'Page' ? 1 : 0}
                value={r[label]}
                onChange={(v) => onChange(i, label, Number(v ?? 0))}
            />
        ),
    }));

function CustomAdTriggers({
    state,
    error,
    saving,
    onSave,
}: {
    state: CustomAdState | null;
    error: string | null;
    saving: boolean;
    onSave: (_c: CustomAdConfig) => void;
}) {
    const [draft, setDraft] = useState<CustomAdConfig | null>(
        state?.config ?? null
    );
    useEffect(() => setDraft(state?.config ?? null), [state]);

    if (!draft || !state) {
        return (
            <Card size="small" title="Custom audience display">
                <Text type="secondary" title={error ?? undefined}>
                    {error ? 'Not reachable' : 'Loading'}
                </Text>
            </Card>
        );
    }

    const setSink = (si: number, next: Partial<CustomAdConfig['sinks'][0]>) =>
        setDraft({
            ...draft,
            sinks: draft.sinks.map((s, j) =>
                j === si ? { ...s, ...next } : s
            ),
        });

    return (
        <Card
            size="small"
            title="Custom audience display"
            extra={
                <Button
                    type="primary"
                    loading={saving}
                    onClick={() => onSave(draft)}
                >
                    Save
                </Button>
            }
        >
            <Space className="bf-trigger-head">
                <Text>Enabled</Text>
                <Switch
                    checked={draft.enabled}
                    onChange={(v) => setDraft({ ...draft, enabled: v })}
                />
            </Space>
            {draft.sinks.map((sink, si) => {
                const rows = Object.entries(sink.buttons).map(([event, b]) => ({
                    event,
                    Page: b.page,
                    Row: b.row,
                    Column: b.column,
                }));
                const setButton = (event: string, b: any) =>
                    setSink(si, { buttons: { ...sink.buttons, [event]: b } });
                const unused = state.events.filter((e) => !sink.buttons[e.id]);
                return (
                    <div key={sink.id} className="bf-sink">
                        <Space wrap size={16} className="bf-trigger-head">
                            <Text strong>{sink.label}</Text>
                            <Switch
                                checked={sink.enabled}
                                onChange={(v) => setSink(si, { enabled: v })}
                            />
                            <Input
                                addonBefore="Companion"
                                className="bf-address"
                                value={sink.address}
                                onChange={(e) =>
                                    setSink(si, { address: e.target.value })
                                }
                            />
                        </Space>
                        <Table
                            rowKey="event"
                            size="small"
                            pagination={false}
                            dataSource={rows}
                            columns={[
                                {
                                    title: 'Event',
                                    key: 'event',
                                    render: (_, r) =>
                                        state.events.find(
                                            (e) => e.id === r.event
                                        )?.label ?? r.event,
                                },
                                ...locationColumns((i, key, v) => {
                                    const r = rows[i];
                                    setButton(r.event, {
                                        page: key === 'Page' ? v : r.Page,
                                        row: key === 'Row' ? v : r.Row,
                                        column: key === 'Column' ? v : r.Column,
                                    });
                                }),
                                {
                                    title: '',
                                    key: 'del',
                                    width: 48,
                                    render: (_, r) => (
                                        <Button
                                            type="text"
                                            danger
                                            icon={<DeleteOutlined />}
                                            onClick={() => {
                                                const next = {
                                                    ...sink.buttons,
                                                };
                                                delete next[r.event];
                                                setSink(si, { buttons: next });
                                            }}
                                        />
                                    ),
                                },
                            ]}
                        />
                        {unused.length > 0 && (
                            <Select
                                className="bf-add bf-event"
                                // Remount after each pick so it shows the placeholder again.
                                key={unused.length}
                                placeholder="Trigger"
                                options={unused.map((e) => ({
                                    value: e.id,
                                    label: e.label,
                                }))}
                                onChange={(event) =>
                                    setButton(event, {
                                        page: 1,
                                        row: 0,
                                        column: 0,
                                    })
                                }
                            />
                        )}
                    </div>
                );
            })}
        </Card>
    );
}

// #endregion

// #region Settings

function SettingsDialog({
    open,
    settings,
    fms,
    onSaveFms,
    onClose,
}: {
    open: boolean;
    settings: BitfocusSettings;
    fms: FmsAutomationConfig | null;
    onSaveFms: (_c: FmsAutomationConfig) => void;
    onClose: () => void;
}) {
    const [form] = Form.useForm<BitfocusSettings & { fmsEnabled: boolean }>();
    useEffect(() => {
        if (open) {
            form.setFieldsValue({
                ...settings,
                fmsEnabled: fms?.BitfocusIntegrationEnabled ?? false,
            });
        }
    }, [open, settings, fms, form]);
    return (
        <Modal
            title="Bitfocus settings"
            open={open}
            onCancel={onClose}
            okText="Save"
            onOk={async () => {
                const v = await form.validateFields();
                send('bitfocus:saveSettings', {
                    customAdUrl: v.customAdUrl,
                });
                if (fms && v.fmsEnabled !== fms.BitfocusIntegrationEnabled) {
                    onSaveFms({
                        ...fms,
                        BitfocusIntegrationEnabled: v.fmsEnabled,
                    });
                }
                onClose();
            }}
            destroyOnClose
        >
            <Form form={form} layout="vertical">
                <Form.Item label="Custom audience display" name="customAdUrl">
                    <Input placeholder="http://10.0.100.20:3001" />
                </Form.Item>
                {fms && (
                    <Form.Item
                        label="FMS Automations"
                        name="fmsEnabled"
                        valuePropName="checked"
                    >
                        <Switch />
                    </Form.Item>
                )}
            </Form>
        </Modal>
    );
}

// #endregion

export default function Bitfocus() {
    const [settings, setSettings] = useState<BitfocusSettings>({
        customAdUrl: '',
    });
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [layout, setLayout] = useState<CompanionLayout | null>(null);
    const [layoutError, setLayoutError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [pageNumber, setPageNumber] = useState(1);
    const [cell, setCell] = useState<{ row: number; column: number } | null>(
        null
    );
    const [saving, setSaving] = useState<string | null>(null);
    const [vmixInputs, setVmixInputs] = useState<string[]>([]);
    const [fms, setFms] = useState<FmsAutomationConfig | null>(null);
    // A save is in flight, so its answer gets a message (a load does not).
    const fmsSaveRef = useRef(false);
    const saveFms = (c: FmsAutomationConfig) => {
        fmsSaveRef.current = true;
        send('bitfocus:saveFms', c);
    };
    const [customAd, setCustomAd] = useState<CustomAdState | null>(null);
    const [customAdError, setCustomAdError] = useState<string | null>(null);

    const loadAll = useCallback(() => {
        setLoading(true);
        send('bitfocus:getLayout');
        send('bitfocus:getVmixInputs');
        send('bitfocus:getFms');
        send('bitfocus:getCustomAd');
    }, []);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const offSettings = ipcRenderer.on(
            'bitfocus:settings',
            (s: BitfocusSettings) => {
                setSettings(s);
                loadAll();
            }
        );
        const offResult = ipcRenderer.on('bitfocus:result', (r: Result) => {
            if (
                r.op === 'layout' ||
                r.op === 'saveButton' ||
                r.op === 'clearButton'
            ) {
                setLoading(false);
                if (r.ok) {
                    setLayout(r.data);
                    setLayoutError(null);
                } else if (r.op === 'layout') {
                    setLayout(null);
                    setLayoutError(r.error ?? 'Not connected');
                } else {
                    message.error(r.error);
                }
                if (r.op !== 'layout') {
                    setSaving((x) => (x === 'button' ? null : x));
                    if (r.ok) {
                        message.success(
                            r.op === 'saveButton' ? 'Saved' : 'Cleared'
                        );
                        setCell(null);
                    }
                }
            }
            if (r.op === 'vmixInputs' && r.ok) setVmixInputs(r.data);
            // Any answer for a section ends that section's save.
            if (r.op === 'fms' || r.op === 'customAd') {
                setSaving((x) => (x === r.op ? null : x));
            }
            // No FMS answer hides the FMS parts; a failed save says so.
            if (r.op === 'fms') {
                if (r.ok) setFms(r.data);
                else if (fmsSaveRef.current) message.error(r.error);
                else setFms(null);
                if (r.ok && fmsSaveRef.current) message.success('Saved');
                fmsSaveRef.current = false;
            }
            if (r.op === 'customAd') {
                if (r.ok) {
                    setCustomAd(r.data);
                    setCustomAdError(null);
                } else {
                    setCustomAdError(r.error ?? 'Not reachable');
                }
            }
        });
        send('bitfocus:getSettings');
        return () => {
            offSettings();
            offResult();
        };
    }, [loadAll]);

    const page = layout?.pages.find((p) => p.number === pageNumber);
    const button = cell
        ? page?.buttons[`${cell.row}/${cell.column}`]
        : undefined;

    const saveButton = (text: string, actions: EditAction[]) => {
        if (!cell || !layout) return;
        const resolved = actions.map((a) => {
            const def = ACTION_DEFS.find((d) => d.key === a.key)!;
            const connectionId =
                def.module === 'internal'
                    ? 'internal'
                    : layout.connections.find((c) => c.module === def.module)
                          ?.id;
            return {
                definitionId: def.definitionId,
                connectionId: connectionId ?? '',
                // Only the fields the editor shows; Companion fills the rest.
                options: {
                    ...Object.fromEntries(
                        def.fields
                            .filter((f) => a.options[f.key] !== undefined)
                            .map((f) => [f.key, a.options[f.key]])
                    ),
                    ...def.fixed,
                },
            };
        });
        setSaving('button');
        send('bitfocus:saveButton', {
            page: pageNumber,
            row: cell.row,
            column: cell.column,
            text,
            actions: resolved,
        });
    };

    // Point the chosen FMS events at this button: drop the commands that press
    // it now, add one per event (keeping an existing command's id).
    const saveTriggers = (events: number[]) => {
        if (!fms || !cell) return;
        const here = commandsAt(fms, pageNumber, cell.row, cell.column);
        const others = fms.BitfocusCommands.filter((c) => !here.includes(c));
        saveFms({
            ...fms,
            BitfocusCommands: [
                ...others,
                ...events.map((e) => ({
                    BfId:
                        here.find((c) => c.BfEvent === e)?.BfId ??
                        crypto.randomUUID(),
                    BfEvent: e,
                    Page: pageNumber,
                    Row: cell.row,
                    Column: cell.column,
                })),
            ],
        });
    };

    const connected = !!layout;

    return (
        <>
            <AddonControlRow
                running={connected}
                statusLabel={connected ? 'Connected' : 'Not connected'}
                onSettings={() => setSettingsOpen(true)}
                extra={
                    <Space>
                        <Button
                            icon={<ReloadOutlined />}
                            loading={loading}
                            onClick={loadAll}
                        />
                        <Button
                            icon={<ExportOutlined />}
                            onClick={() => send('bitfocus:openCompanion')}
                        >
                            Companion
                        </Button>
                    </Space>
                }
            />
            <div className="bf-page">
                <Card size="small" title="Buttons">
                    {layout ? (
                        <>
                            <Tabs
                                activeKey={String(pageNumber)}
                                onChange={(k) => setPageNumber(Number(k))}
                                items={layout.pages.map((p) => ({
                                    key: String(p.number),
                                    label: p.name || `Page ${p.number}`,
                                }))}
                            />
                            {page && (
                                <ButtonGrid
                                    page={page}
                                    fms={fms}
                                    onPick={(row, column) =>
                                        setCell({ row, column })
                                    }
                                />
                            )}
                        </>
                    ) : (
                        <span title={layoutError ?? undefined}>
                            <Empty
                                description={
                                    layoutError ? 'Not connected' : 'Loading'
                                }
                            />
                        </span>
                    )}
                </Card>
                {settings.customAdUrl && (
                    <CustomAdTriggers
                        state={customAd}
                        error={customAdError}
                        saving={saving === 'customAd'}
                        onSave={(c) => {
                            setSaving('customAd');
                            send('bitfocus:saveCustomAd', c);
                        }}
                    />
                )}
            </div>
            <ButtonEditor
                open={!!cell}
                page={page}
                cell={cell}
                button={button}
                layout={layout}
                vmixInputs={vmixInputs}
                fms={fms}
                saving={saving === 'button'}
                onSave={saveButton}
                onSaveTriggers={saveTriggers}
                onClear={() => {
                    if (!cell) return;
                    setSaving('button');
                    send(
                        'bitfocus:clearButton',
                        pageNumber,
                        cell.row,
                        cell.column
                    );
                }}
                onClose={() => setCell(null)}
            />
            <SettingsDialog
                open={settingsOpen}
                settings={settings}
                fms={fms}
                onSaveFms={saveFms}
                onClose={() => setSettingsOpen(false)}
            />
        </>
    );
}
