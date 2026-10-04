import zlib from 'zlib';
import WebSocket from 'ws';
import {
    CompanionAction,
    CompanionButton,
    CompanionLayout,
    CompanionPage,
    CustomAdConfig,
    CustomAdState,
    FmsAutomationConfig,
    matchActionDef,
} from '../models/Bitfocus';

// Bitfocus Companion + audience-display trigger access for the Bitfocus tab.
//
// Reading: Companion's full config export (GET /int/export/full, gzipped JSON)
// gives every page, button and connection in one request.
//
// Writing: Companion has no public API for editing buttons. Its own web UI
// edits over tRPC on ws://<host>/trpc, and this uses the same calls
// (controls.resetControl, controls.entities.add/setOption/remove,
// controls.styles.updateOption), verified against Companion 5.0. It runs here
// in the main process because Companion refuses a WebSocket whose browser
// Origin does not match its own host, and a Node client sends no Origin.

const FMS_URL = 'http://10.0.100.5';

// Companion runs on the AV machine itself, for FIM-AV and for the FMS audience
// display alike.
export const COMPANION_URL = 'http://127.0.0.1:8000';

// The custom audience display is run by AudienceDisplayAddon on this machine.
export const CUSTOM_AD_URL = 'http://127.0.0.1:3001';

// #region Companion read

type Opt = { value?: unknown; isExpression?: boolean } | unknown;

function plain(v: Opt): unknown {
    if (v && typeof v === 'object' && 'value' in (v as object)) {
        return (v as { value: unknown }).value;
    }
    return v;
}

function buttonText(ctl: any): string {
    const layers: any[] = ctl?.style?.layers ?? [];
    const text = layers.find((l) => l?.type === 'text');
    if (text) return String(plain(text.text) ?? '');
    return String(ctl?.style?.text ?? '');
}

function buttonActions(ctl: any): CompanionAction[] {
    const down: any[] = ctl?.steps?.['0']?.action_sets?.down ?? [];
    return down.map((a) => ({
        id: a.id,
        definitionId: a.definitionId ?? a.action,
        connectionId: a.connectionId ?? a.instance,
        options: Object.fromEntries(
            Object.entries(a.options ?? {}).map(([k, v]) => [k, plain(v)])
        ),
        hasExpression: Object.values(a.options ?? {}).some(
            (v: any) => v?.isExpression === true
        ),
    }));
}

export async function readCompanionLayout(
    baseUrl: string
): Promise<CompanionLayout> {
    const res = await fetch(`${baseUrl}/int/export/full`, {
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Companion export: HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    const json = JSON.parse(
        (raw[0] === 0x1f && raw[1] === 0x8b
            ? zlib.gunzipSync(raw)
            : raw
        ).toString('utf8')
    );

    const pages: CompanionPage[] = Object.entries(json.pages ?? {})
        .map(([num, p]: [string, any]) => {
            const buttons: Record<string, CompanionButton> = {};
            Object.entries(p.controls ?? {}).forEach(
                ([r, row]: [string, any]) =>
                    Object.entries(row ?? {}).forEach(
                        ([c, ctl]: [string, any]) => {
                            buttons[`${r}/${c}`] = {
                                type: ctl?.type ?? '',
                                text: buttonText(ctl),
                                actions: buttonActions(ctl),
                            };
                        }
                    )
            );
            const grid = p.gridSize ?? {};
            return {
                number: Number(num),
                name: p.name ?? '',
                rows: (grid.maxRow ?? 3) - (grid.minRow ?? 0) + 1,
                columns: (grid.maxColumn ?? 7) - (grid.minColumn ?? 0) + 1,
                buttons,
            };
        })
        .sort((a, b) => a.number - b.number);

    const connections = Object.entries(json.instances ?? {})
        .filter(([, i]: [string, any]) => i?.instance_type || i?.moduleId)
        .map(([id, i]: [string, any]) => ({
            id,
            module: i.instance_type ?? i.moduleId,
            label: i.label ?? id,
        }));

    return { pages, connections };
}

// #endregion

// #region Companion write (tRPC over WebSocket)

class TrpcSession {
    private ws: WebSocket;

    private nextId = 0;

    private waiting = new Map<number, (_m: any) => void>();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.on('message', (data) => {
            const m = JSON.parse(String(data));
            const cb = this.waiting.get(m.id);
            if (!cb) return;
            // A subscription answers "started" before its first data.
            if (m.result?.type === 'started') return;
            this.waiting.delete(m.id);
            cb(m);
        });
    }

    static open(baseUrl: string): Promise<TrpcSession> {
        const url = `${baseUrl.replace(/^http/, 'ws')}/trpc`;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                ws.terminate();
                reject(new Error('Companion did not answer'));
            }, 8000);
            ws.once('open', () => {
                clearTimeout(timer);
                resolve(new TrpcSession(ws));
            });
            ws.once('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    private send(method: string, path: string, input: unknown): Promise<any> {
        this.nextId += 1;
        const id = this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`Companion: ${path} timed out`));
            }, 8000);
            this.waiting.set(id, (m) => {
                clearTimeout(timer);
                if (m.error) {
                    reject(
                        new Error(
                            `Companion: ${path}: ${
                                m.error.message ?? JSON.stringify(m.error)
                            }`
                        )
                    );
                } else {
                    resolve(m.result?.data);
                }
            });
            this.ws.send(
                JSON.stringify({ id, method, params: { path, input } })
            );
            if (method === 'subscription') {
                // Only the first value is wanted; stop once it arrives.
                const stop = this.waiting.get(id)!;
                this.waiting.set(id, (m) => {
                    this.ws.send(
                        JSON.stringify({ id, method: 'subscription.stop' })
                    );
                    stop(m);
                });
            }
        });
    }

    mutate(path: string, input: unknown) {
        return this.send('mutation', path, input);
    }

    first(path: string, input: unknown) {
        return this.send('subscription', path, input);
    }

    close() {
        this.ws.close();
    }
}

const value = (v: unknown) => ({ isExpression: false, value: v });

export interface ButtonEdit {
    page: number;
    row: number;
    column: number;
    text: string;
    // In order; options hold plain values.
    actions: {
        definitionId: string;
        connectionId: string;
        options: Record<string, unknown>;
    }[];
}

async function controlIdAt(
    s: TrpcSession,
    page: number,
    row: number,
    column: number
): Promise<string | null> {
    const pages = await s.first('pages.watch', undefined);
    const pageId = pages?.order?.[page - 1];
    return pages?.pages?.[pageId]?.controls?.[row]?.[column] ?? null;
}

const DOWN = { stepId: '0', setId: 'down' };

// Write one button: create it if the cell is empty, set its label, and replace
// its press actions with the given list. Only buttons whose actions are all in
// the catalog are edited this way (the tab checks), so replacing the list
// cannot drop an action the editor does not show.
export async function saveCompanionButton(
    baseUrl: string,
    edit: ButtonEdit
): Promise<void> {
    const s = await TrpcSession.open(baseUrl);
    try {
        const location = {
            pageNumber: edit.page,
            row: edit.row,
            column: edit.column,
        };
        let controlId = await controlIdAt(s, edit.page, edit.row, edit.column);
        if (!controlId) {
            await s.mutate('controls.resetControl', {
                location,
                newType: 'button-layered',
            });
            controlId = await controlIdAt(s, edit.page, edit.row, edit.column);
            if (!controlId)
                throw new Error('Companion did not create the button');
        }

        const init = await s.first('controls.watchControl', { controlId });
        const config = init?.config;
        if (config?.type !== 'button-layered') {
            throw new Error('Not an editable button');
        }
        const current: any[] = config.steps?.['0']?.action_sets?.down ?? [];
        const editable = (a: any) =>
            !Object.values(a.options ?? {}).some(
                (v: any) => v?.isExpression === true
            ) &&
            matchActionDef(
                a.definitionId,
                Object.fromEntries(
                    Object.entries(a.options ?? {}).map(([k, v]) => [
                        k,
                        plain(v),
                    ])
                )
            );
        if (current.some((a) => !editable(a))) {
            throw new Error('Button has actions only Companion can edit');
        }

        const textLayer = (config.style?.layers ?? []).find(
            (l: any) => l?.type === 'text'
        );
        if (textLayer) {
            await s.mutate('controls.styles.updateOption', {
                controlId,
                elementId: textLayer.id,
                key: 'text',
                value: value(edit.text),
            });
        }

        // Replace the press actions: remove the old ones, add the new list in
        // order (add appends, so order is kept).
        // eslint-disable-next-line no-restricted-syntax
        for (const a of current) {
            // eslint-disable-next-line no-await-in-loop
            await s.mutate('controls.entities.remove', {
                controlId,
                entityLocation: DOWN,
                entityId: a.id,
            });
        }
        // eslint-disable-next-line no-restricted-syntax
        for (const a of edit.actions) {
            // eslint-disable-next-line no-await-in-loop
            const entityId = await s.mutate('controls.entities.add', {
                controlId,
                entityLocation: DOWN,
                ownerId: null,
                connectionId: a.connectionId,
                entityType: 'action',
                entityDefinition: a.definitionId,
            });
            if (!entityId) {
                throw new Error(`Companion refused action ${a.definitionId}`);
            }
            // eslint-disable-next-line no-restricted-syntax
            for (const [key, v] of Object.entries(a.options)) {
                // eslint-disable-next-line no-await-in-loop
                await s.mutate('controls.entities.setOption', {
                    controlId,
                    entityLocation: DOWN,
                    entityId,
                    key,
                    value: value(v),
                });
            }
        }
    } finally {
        s.close();
    }
}

export async function clearCompanionButton(
    baseUrl: string,
    page: number,
    row: number,
    column: number
): Promise<void> {
    const s = await TrpcSession.open(baseUrl);
    try {
        await s.mutate('controls.resetControl', {
            location: { pageNumber: page, row, column },
        });
    } finally {
        s.close();
    }
}

// #endregion

// #region Audience-display triggers

// Official FMS audience display. The whole ConfigValue is read and written
// back, so only AutomationConfig changes.
export async function readFmsAutomation(): Promise<FmsAutomationConfig> {
    const res = await fetch(
        `${FMS_URL}/api/v1.0/audience/get/GetAudienceDisplayConfigs`,
        { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`FMS: HTTP ${res.status}`);
    const body = await res.json();
    const primary = (body?.Configs ?? []).find(
        (c: any) => c.ConfigId === 'Primary'
    );
    if (!primary) throw new Error('FMS: no Primary audience display config');
    return primary.ConfigValue.AutomationConfig;
}

export async function saveFmsAutomation(
    automation: FmsAutomationConfig
): Promise<FmsAutomationConfig> {
    const res = await fetch(
        `${FMS_URL}/api/v1.0/audience/get/GetAudienceDisplayConfigs`,
        { signal: AbortSignal.timeout(5000) }
    );
    const body = await res.json();
    const primary = (body?.Configs ?? []).find(
        (c: any) => c.ConfigId === 'Primary'
    );
    if (!primary) throw new Error('FMS: no Primary audience display config');
    const next = {
        ...primary.ConfigValue,
        AutomationConfig: {
            ...automation,
            BitfocusIntegrationAddress: COMPANION_URL,
        },
    };
    const save = await fetch(
        `${FMS_URL}/api/v1.0/audience/set/SaveAudienceDisplayConfig/Primary`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
            signal: AbortSignal.timeout(5000),
        }
    );
    if (!save.ok) throw new Error(`FMS save: HTTP ${save.status}`);
    return readFmsAutomation();
}

// Our custom audience display.
export async function readCustomAd(baseUrl: string): Promise<CustomAdState> {
    const res = await fetch(`${baseUrl}/api/companion/config`, {
        signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (!body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return { config: body.config, events: body.events };
}

export async function saveCustomAd(
    baseUrl: string,
    config: CustomAdConfig
): Promise<CustomAdState> {
    const res = await fetch(`${baseUrl}/api/companion/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (!body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return readCustomAd(baseUrl);
}

// #endregion
