import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AudioSection from '../renderer/pages/vmix/Levels';
import { LevelState, WizardState } from '../models/Levels';

jest.mock('../renderer/hooks/checks', () => ({
    __esModule: true,
    default: () => [
        {
            id: 'stream-loudness',
            group: 'Audio',
            label: 'Stream loudness',
            state: 'warning',
            detail: 'Q12: Too quiet, Stream audio +4.0 dB (-22.0 LUFS)',
        },
    ],
}));

// The main process side of the IPC, as window.electron exposes it.
const listeners = new Map<string, (_arg: unknown) => void>();
const sent: [string, unknown[]][] = [];
beforeAll(() => {
    // jsdom has no matchMedia; antd's grid asks for it.
    window.matchMedia =
        window.matchMedia ||
        ((() => ({
            matches: false,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        })) as any);
    (window as any).electron = {
        ipcRenderer: {
            sendMessage: (c: string, a: unknown[]) => sent.push([c, a]),
            on: (c: string, fn: (_arg: unknown) => void) => {
                listeners.set(c, fn);
                return () => listeners.delete(c);
            },
        },
    };
});

const wizard = (over: Partial<WizardState> = {}): WizardState => ({
    step: 'red',
    steps: ['red', 'blue', 'match', 'dj', 'stream', 'check'],
    input: -22,
    fader: -50,
    faderTarget: 'Master',
    matchRunning: null,
    noPreamp: [],
    djSendOff: false,
    djOnStream: false,
    toPost: [],
    madePost: [],
    rows: (['red', 'blue', 'match', 'dj'] as const).map((id) => ({
        id,
        label: {
            red: 'Red mic',
            blue: 'Blue mic',
            match: 'Match sounds',
            dj: 'DJ',
        }[id],
        status: 'listening',
        input: -21,
        bus: -20,
        stream: -14,
        sendLimited: null,
    })),
    plan: {
        busFrom: 0,
        busTo: 6,
        lufs: -14,
        peak: -4,
        estimate: true,
        limitedBy: null,
    },
    busAVolume: 80,
    stream: { running: false, failed: 'Not Windows', momentary: null },
    verify: { from: null, lufs: null, peak: null, seconds: 0, residual: null },
    applied: false,
    undo: 1,
    busy: false,
    error: null,
    ...over,
});

const push = (st: LevelState) =>
    act(() => {
        listeners.get('levels:state')?.(st);
    });

const base: LevelState = {
    mixer: true,
    streamBus: 1,
    masterOut: -18.25,
    streamOut: -30,
    wizard: null,
};

describe('vMix / X-Air audio section', () => {
    it('meters, loudness verdict and the wizard button', () => {
        render(<AudioSection />);
        push(base);
        expect(screen.getByText('Master out')).toBeInTheDocument();
        expect(screen.getByText('Stream out')).toBeInTheDocument();
        expect(screen.getByText('−18.3 dBFS')).toBeInTheDocument();
        expect(
            screen.getByText(/Too quiet, Stream audio \+4.0 dB/)
        ).toBeInTheDocument();
        fireEvent.click(screen.getByText('Level wizard'));
        expect(sent).toContainEqual(['levels:start', []]);
    });

    it('red mic step: picture, setup tags, Master fader', () => {
        render(<AudioSection />);
        push({ ...base, wizard: wizard() });
        expect(
            screen.getByRole('img', { name: 'Wireless mic' })
        ).toBeInTheDocument();
        expect(screen.getByText('Gain +20 dB')).toBeInTheDocument();
        expect(
            screen.getByText('−'.concat('50 dB'), { exact: false })
        ).toBeInTheDocument();
        expect(screen.getByText('Listening')).toBeInTheDocument();
        expect(screen.getAllByText('Master').length).toBeGreaterThan(0);
    });

    it('DJ step: checklist and the stream send off', () => {
        render(<AudioSection />);
        push({
            ...base,
            wizard: wizard({ step: 'dj', faderTarget: 'DJ', djSendOff: true }),
        });
        expect(screen.getByText('Laptop volume 100%')).toBeInTheDocument();
        expect(screen.getByText('DI box level 50%')).toBeInTheDocument();
        expect(screen.getByText('DJ Bus 1 send off')).toBeInTheDocument();
    });

    it('stream step: table without DJ, plan, Bus A, Apply', () => {
        render(<AudioSection />);
        push({ ...base, wizard: wizard({ step: 'stream' }) });
        expect(screen.getByText('Bus 1 dBFS')).toBeInTheDocument();
        // Master is never judged or worked out: no Master column.
        expect(screen.queryByText('Master dBFS')).toBeNull();
        expect(screen.getByText('Stream LUFS')).toBeInTheDocument();
        expect(screen.queryByRole('cell', { name: 'DJ' })).toBeNull();
        expect(screen.getByText('Estimate')).toBeInTheDocument();
        expect(screen.getByText('Bus A 80%')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Apply'));
        expect(sent).toContainEqual(['levels:apply', []]);
    });
});
