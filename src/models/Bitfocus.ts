// Shared shapes for the Bitfocus tab: the Companion button layout FIM-AV
// reads, the small set of actions it can edit, and the audience-display
// trigger configs (official FMS and our custom display).

// #region Companion layout

export interface CompanionAction {
    id: string;
    definitionId: string;
    connectionId: string;
    // Plain option values (Companion stores {value, isExpression}; expressions
    // are not edited here, so only the value is carried).
    options: Record<string, unknown>;
}

export interface CompanionButton {
    // 'button-layered' is an editable button; page up/down/number are not.
    type: string;
    text: string;
    actions: CompanionAction[];
}

export interface CompanionPage {
    number: number;
    name: string;
    rows: number;
    columns: number;
    // `${row}/${column}` -> button
    buttons: Record<string, CompanionButton>;
}

export interface CompanionConnection {
    id: string;
    module: string;
    label: string;
}

export interface CompanionLayout {
    pages: CompanionPage[];
    connections: CompanionConnection[];
}

// #endregion

// #region Action catalog

export type ActionFieldType = 'vmixInput' | 'number' | 'select';

export interface ActionField {
    key: string;
    label: string;
    type: ActionFieldType;
    options?: { value: string; label: string }[];
    // Companion stores some numbers as strings (wait time); keep its type.
    asString?: boolean;
}

export interface ActionDef {
    // Stable key for the editor: `${module}:${definitionId}`
    key: string;
    // Companion module id of the connection the action runs on; 'internal' is
    // Companion itself.
    module: string;
    definitionId: string;
    label: string;
    fields: ActionField[];
}

const OVERLAY_FUNCTIONS = [1, 2, 3, 4].flatMap((n) => [
    { value: `OverlayInput${n}`, label: `Overlay ${n} toggle` },
    { value: `OverlayInput${n}In`, label: `Overlay ${n} in` },
    { value: `OverlayInput${n}Out`, label: `Overlay ${n} out` },
    { value: `OverlayInput${n}Off`, label: `Overlay ${n} off` },
]);

// X-Air: channels mute with 0, mute groups with 1 (the module flips them).
const CHANNEL_MUTE = [
    { value: '0', label: 'Mute' },
    { value: '1', label: 'Unmute' },
    { value: '2', label: 'Toggle' },
];
const GROUP_MUTE = [
    { value: '1', label: 'Mute' },
    { value: '0', label: 'Unmute' },
    { value: '2', label: 'Toggle' },
];

// The actions FIM's Companion profiles use. Anything else on a button is left
// alone and edited in Companion itself.
export const ACTION_DEFS: ActionDef[] = [
    {
        key: 'studiocoast-vmix:programCut',
        module: 'studiocoast-vmix',
        definitionId: 'programCut',
        label: 'Cut',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:quickPlay',
        module: 'studiocoast-vmix',
        definitionId: 'quickPlay',
        label: 'Quick play',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:previewInput',
        module: 'studiocoast-vmix',
        definitionId: 'previewInput',
        label: 'Preview',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:overlayFunctions',
        module: 'studiocoast-vmix',
        definitionId: 'overlayFunctions',
        label: 'Overlay',
        fields: [
            {
                key: 'functionID',
                label: 'Overlay',
                type: 'select',
                options: OVERLAY_FUNCTIONS,
            },
            { key: 'input', label: 'Input', type: 'vmixInput' },
        ],
    },
    {
        key: 'internal:wait',
        module: 'internal',
        definitionId: 'wait',
        label: 'Wait',
        fields: [
            { key: 'time', label: 'Time', type: 'number', asString: true },
        ],
    },
    {
        key: 'internal:set_page',
        module: 'internal',
        definitionId: 'set_page',
        label: 'Page',
        fields: [{ key: 'page', label: 'Page', type: 'number' }],
    },
    {
        key: 'behringer-xair:mute',
        module: 'behringer-xair',
        definitionId: 'mute',
        label: 'Mute channel',
        fields: [
            { key: 'num', label: 'Channel', type: 'number' },
            {
                key: 'mute',
                label: 'Mute',
                type: 'select',
                options: CHANNEL_MUTE,
            },
        ],
    },
    {
        key: 'behringer-xair:mute_grp',
        module: 'behringer-xair',
        definitionId: 'mute_grp',
        label: 'Mute group',
        fields: [
            { key: 'mute_grp', label: 'Group', type: 'number', asString: true },
            { key: 'mute', label: 'Mute', type: 'select', options: GROUP_MUTE },
        ],
    },
];

// #endregion

// #region Audience-display triggers

// Official FMS audience display: BitfocusStateTypes, in enum order.
export const FMS_BITFOCUS_EVENTS: { value: number; label: string }[] = [
    { value: 1, label: 'Prestart' },
    { value: 2, label: 'Match Preview' },
    { value: 3, label: 'Score Bar' },
    { value: 4, label: 'Field Ready' },
    { value: 5, label: 'Match Start' },
    { value: 6, label: 'Teleop Start' },
    { value: 7, label: 'Endgame Start' },
    { value: 8, label: 'Match End' },
    { value: 9, label: 'Abort Match' },
    { value: 10, label: 'Post Result' },
    { value: 11, label: 'Alliance Selection' },
    { value: 12, label: 'Award' },
    { value: 13, label: 'Award Reveal' },
    { value: 14, label: 'Playoff Bracket' },
    { value: 15, label: 'Red Wins' },
    { value: 16, label: 'Blue Wins' },
    { value: 17, label: 'Tie Match' },
];

export interface FmsBitfocusCommand {
    BfId: string;
    BfEvent: number;
    Page: number;
    Row: number;
    Column: number;
}

export interface FmsAutomationConfig {
    BitfocusIntegrationEnabled: boolean;
    BitfocusIntegrationAddress: string;
    BitfocusCommands: FmsBitfocusCommand[];
    SetMatchNameCustomVariable: boolean;
    MatchNameCustomVariableName: string;
}

// Our custom audience display (/api/companion/config)
export interface CustomAdSink {
    id: string;
    label: string;
    address: string;
    enabled: boolean;
    buttons: Record<string, { page: number; row: number; column: number }>;
}

export interface CustomAdConfig {
    enabled: boolean;
    variablesEnabled: boolean;
    liveScores: boolean;
    sinks: CustomAdSink[];
}

export interface CustomAdState {
    config: CustomAdConfig;
    events: { id: string; label: string }[];
}

// #endregion
