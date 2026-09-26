import Store from 'electron-store';

export type AppConfig = {
    signalrUrl: unknown;
    apiKey: unknown;
    liveCaptionsDownloadBase: string;
    runOnStartup: boolean;
    currentStep: number;
    stepsStartedAt: number;
    vmixApi: {
        baseUrl: string;
        username: string;
        password: string;
    };
    // Last event we successfully pushed stream keys to vMix for. vMix can't be
    // read back for the key, so we track "did we set it for this event" here.
    vmixStreamKeys: {
        eventCode: string;
        eventName: string;
        setAt: number;
    } | null;
    // Saved alliance-selection composite geometry (tunable live, then saved).
    vmixComposite: {
        layer: number;
        zoom: number;
        panX: number;
        panY: number;
    };
    autoAv: {
        fileNameMode: 'in-season' | 'off-season';
        // Manual event name; when set it overrides whatever FMS reports
        eventNameOverride: string;
        // FMS event code the name was last auto-filled from. The name is only
        // replaced again when FMS reports a different code, so a hand edit
        // sticks for the rest of the event.
        lastFmsEventCode: string;
        // Destination folder for renamed match videos; blank = alongside the
        // vMix recording
        saveFolder: string;
        // The actual event folder the last recording was filed into, so the tab
        // can show the real path even with no configured save folder
        lastSaveFolder: string;
        // Auto-cut the dead time out of each recording after it's filed,
        // producing a clean uploadable copy in a "Cut" subfolder.
        autoCut: boolean;
    };
    // YouTube + TBA upload settings for the Upload tab. Persisted here and also
    // pushed to the youtube-tba-upload sidecar via POST /api/upload/config.
    // Field shapes mirror the sidecar's eventConfig (INTEGRATION.md §4).
    upload: {
        // TBA event trusted-API credentials
        tbaAuthId: string;
        tbaSecret: string;
        // Post the YouTube URL to TBA automatically after each upload
        autoSubmitTba: boolean;
        // Target YouTube playlist (id is stored; name is display + fallback)
        playlistId: string;
        playlistName: string;
        // Title / description templates the sidecar fills per match
        titleTemplate: string;
        descriptionTemplate: string;
        // Thumbnail image applied to each upload
        thumbnailPath: string;
        // Run the upload browser hidden (default). Sign-in is always headed.
        headless: boolean;
        // YouTube visibility for uploaded videos
        visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
    };
};

// UI defaults must equal the sidecar's own defaults verbatim (INTEGRATION.md
// §4 / state.go), so the form shows exactly what the sidecar would fill.
export const DEFAULT_TITLE_TEMPLATE =
    '{video_prefix} {match_level} Match {match_number}{play_suffix}';
export const DEFAULT_DESCRIPTION_TEMPLATE = [
    '{title}',
    '',
    'Red Alliance:',
    '- {red[0].number} {red[0].name}',
    '- {red[1].number} {red[1].name}',
    '- {red[2].number} {red[2].name}',
    '',
    'Blue Alliance:',
    '- {blue[0].number} {blue[0].name}',
    '- {blue[1].number} {blue[1].name}',
    '- {blue[2].number} {blue[2].name}',
].join('\n');

export function createStore(): Store<AppConfig> {
    return new Store({
        schema: {
            signalrUrl: {
                type: 'string',
                default: 'https://fim-admin.evandoes.dev/AssistantHub',
            },
            apiKey: {
                type: ['string', 'null'],
                default: null,
            },
            liveCaptionsDownloadBase: {
                type: 'string',
                default: 'https://github.com/Filip-Kin/live-captions/releases',
            },
            runOnStartup: {
                type: 'boolean',
                default: true,
            },
            currentStep: {
                type: 'number',
                default: 0,
            },
            stepsStartedAt: {
                type: 'number',
                default: 0,
            },
            vmixApi: {
                type: 'object',
                properties: {
                    baseUrl: {
                        type: 'string',
                        default: 'http://127.0.0.1:8088/api',
                    },
                    username: {
                        type: 'string',
                        default: 'user',
                    },
                    password: {
                        type: 'string',
                        default: 'pass',
                    },
                },
            },
            vmixStreamKeys: {
                type: ['object', 'null'],
                default: null,
            },
            vmixComposite: {
                type: 'object',
                // Perfect-fit values for the official AD camera box, measured
                // live (X133.6 Y29.2 W844.4 H475 in 1920x1080): zoom = W/1920,
                // panX = (centerX-960)/960, panY = (540-centerY)/540.
                default: {
                    layer: 1,
                    zoom: 0.4398,
                    panX: -0.421,
                    panY: 0.5061,
                },
            },
            autoAv: {
                type: 'object',
                properties: {
                    fileNameMode: {
                        type: 'string',
                        default: 'in-season',
                    },
                    eventNameOverride: {
                        type: 'string',
                        default: '',
                    },
                    lastFmsEventCode: {
                        type: 'string',
                        default: '',
                    },
                    saveFolder: {
                        type: 'string',
                        default: '',
                    },
                    lastSaveFolder: {
                        type: 'string',
                        default: '',
                    },
                    autoCut: {
                        type: 'boolean',
                        default: false,
                    },
                },
            },
            upload: {
                type: 'object',
                properties: {
                    tbaAuthId: { type: 'string', default: '' },
                    tbaSecret: { type: 'string', default: '' },
                    autoSubmitTba: { type: 'boolean', default: true },
                    playlistId: { type: 'string', default: '' },
                    playlistName: { type: 'string', default: '' },
                    titleTemplate: {
                        type: 'string',
                        default: DEFAULT_TITLE_TEMPLATE,
                    },
                    descriptionTemplate: {
                        type: 'string',
                        default: DEFAULT_DESCRIPTION_TEMPLATE,
                    },
                    thumbnailPath: { type: 'string', default: '' },
                    headless: { type: 'boolean', default: true },
                    visibility: { type: 'string', default: 'UNLISTED' },
                },
                default: {
                    tbaAuthId: '',
                    tbaSecret: '',
                    autoSubmitTba: true,
                    playlistId: '',
                    playlistName: '',
                    titleTemplate: DEFAULT_TITLE_TEMPLATE,
                    descriptionTemplate: DEFAULT_DESCRIPTION_TEMPLATE,
                    thumbnailPath: '',
                    headless: true,
                    visibility: 'UNLISTED',
                },
            },
        },
        migrations: {
            '0.0.4': (store) => {
                store.set(
                    'liveCaptionsDownloadBase',
                    'https://github.com/Filip-Kin/live-captions/releases'
                );
                if (!store.has('apiKey')) store.set('apiKey', null);
            },
            '0.0.6': (store) => {
                store.set('runOnStartup', true);
            },
            '0.0.11': (store) => {
                store.set('currentStep', 0);
                store.set('stepsStartedAt', 0);
            },
            '0.0.17': (store) => {
                store.set('vmixApi', {
                    baseUrl: 'http://127.0.0.1:8000/api',
                    username: 'user',
                    password: 'pass',
                });
            },
            '0.0.29': (store) => {
                store.set('autoAv.fileNameMode', 'in-season');
            },
            // vMix serves its web API on 8088 by default; the old 8000 default
            // was a placeholder that never matched a stock vMix. Repoint any
            // install still on it.
            '2026.2.3': (store) => {
                const vmix = store.get('vmixApi') as
                    | AppConfig['vmixApi']
                    | undefined;
                if (vmix?.baseUrl === 'http://127.0.0.1:8000/api') {
                    store.set('vmixApi', {
                        ...vmix,
                        baseUrl: 'http://127.0.0.1:8088/api',
                    });
                }
            },
            // Seed the Upload tab's settings for installs that predate it, and
            // drop the retired include_practice/include_test flags (the sidecar
            // hard-excludes practice/test now).
            '2026.3.3': (store) => {
                const existing =
                    (store.get('upload') as Partial<
                        AppConfig['upload']
                    >) ?? {};
                store.set('upload', {
                    tbaAuthId: existing.tbaAuthId ?? '',
                    tbaSecret: existing.tbaSecret ?? '',
                    autoSubmitTba: existing.autoSubmitTba ?? true,
                    playlistId: existing.playlistId ?? '',
                    playlistName: existing.playlistName ?? '',
                    titleTemplate:
                        existing.titleTemplate || DEFAULT_TITLE_TEMPLATE,
                    descriptionTemplate:
                        existing.descriptionTemplate ||
                        DEFAULT_DESCRIPTION_TEMPLATE,
                    thumbnailPath: existing.thumbnailPath ?? '',
                    headless: existing.headless ?? true,
                    visibility: existing.visibility ?? 'UNLISTED',
                });
            },
        },
    }) as Store<AppConfig>;
}

let store: Store<AppConfig> | undefined;

export function getStore(): Store<AppConfig> {
    if (store === undefined) store = createStore();
    return store;
}
