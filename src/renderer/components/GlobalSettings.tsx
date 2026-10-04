import { useEffect, useState } from 'react';
import {
    Button,
    Form,
    Input,
    Modal,
    Select,
    Space,
    Typography,
    message,
} from 'antd';
import { AutoAVStatus } from 'models/AutoAVStatus';
import { FtcScorekeeperStatus, FtcSettings } from 'models/Ftc';

const { Text } = Typography;

type ProgramSetting = 'auto' | 'frc' | 'ftc';

const send = (channel: string, ...args: unknown[]) =>
    window.electron?.ipcRenderer.sendMessage(channel, args);

// App-wide settings, opened from "Settings" in the menu bar: FRC / FTC
// (detected, with an override), the FRC off-season audience display (reset
// to FMS at each new event) and the FTC Live scorekeeper. FTC recording
// length lives in Auto AV's settings.
export default function GlobalSettings() {
    const [open, setOpen] = useState(false);
    const [program, setProgram] = useState<ProgramSetting>('auto');
    const [detected, setDetected] =
        useState<AutoAVStatus['programDetected']>(null);
    const [frcAd, setFrcAd] = useState<'fms' | 'customAd'>('fms');
    const [address, setAddress] = useState('');
    const [ftcStatus, setFtcStatus] = useState<FtcScorekeeperStatus | null>(
        null
    );
    const [scanning, setScanning] = useState(false);
    const [found, setFound] = useState<string[] | null>(null);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const offs = [
            ipcRenderer.on('app:openSettings', () => {
                setFound(null);
                setOpen(true);
                send('app:getSettings');
                send('ftc:getState');
                send('autoav:getState');
            }),
            ipcRenderer.on(
                'app:settings',
                (s: {
                    program: ProgramSetting;
                    frcAudienceDisplay: 'fms' | 'customAd';
                }) => {
                    setProgram(s.program);
                    setFrcAd(s.frcAudienceDisplay);
                }
            ),
            ipcRenderer.on('ftc:settings', (s: FtcSettings) => {
                setAddress(s.address);
            }),
            ipcRenderer.on('ftc:status', (s: FtcScorekeeperStatus) =>
                setFtcStatus(s)
            ),
            ipcRenderer.on('autoav:status', (s: AutoAVStatus) =>
                setDetected(s.programDetected)
            ),
        ];
        return () => offs.forEach((off) => off());
    }, []);

    const scan = () => {
        if (!window.electron) return;
        setScanning(true);
        const off = window.electron.ipcRenderer.on(
            'ftc:scanResult',
            (list: string[]) => {
                off();
                setScanning(false);
                setFound(list);
                if (list.length === 1) setAddress(list[0]);
            }
        );
        send('ftc:scan');
    };

    const save = () => {
        send('app:saveSettings', { program, frcAudienceDisplay: frcAd });
        if (program !== 'frc') {
            send('ftc:saveSettings', { address });
        }
        message.success('Saved');
        setOpen(false);
    };

    const detectedLabel = { frc: 'FRC', ftc: 'FTC' }[detected ?? 'frc'];

    return (
        <Modal
            title="Settings"
            open={open}
            onCancel={() => setOpen(false)}
            onOk={save}
            okText="Save"
            destroyOnClose
        >
            <Form layout="vertical">
                <Form.Item label="Program">
                    <Select
                        value={program}
                        onChange={setProgram}
                        options={[
                            {
                                value: 'auto',
                                label: detected
                                    ? `Auto (${detectedLabel})`
                                    : 'Auto',
                            },
                            { value: 'frc', label: 'FRC' },
                            { value: 'ftc', label: 'FTC' },
                        ]}
                    />
                </Form.Item>
                {program !== 'ftc' && (
                    <Form.Item label="FRC audience display">
                        <Select
                            value={frcAd}
                            onChange={setFrcAd}
                            options={[
                                { value: 'fms', label: 'FMS' },
                                {
                                    value: 'customAd',
                                    label: 'Custom AD (off-season)',
                                },
                            ]}
                        />
                    </Form.Item>
                )}
                {program !== 'frc' && (
                    <Form.Item label="FTC scorekeeper">
                        <Space.Compact style={{ width: '100%' }}>
                            <Input
                                placeholder="172.18.5.212"
                                value={address}
                                onChange={(e) => setAddress(e.target.value)}
                                status={
                                    ftcStatus?.address === address &&
                                    address &&
                                    !ftcStatus.connected
                                        ? 'error'
                                        : undefined
                                }
                            />
                            <Button loading={scanning} onClick={scan}>
                                Scan
                            </Button>
                        </Space.Compact>
                        {found && found.length > 1 && (
                            <Select
                                style={{ width: '100%', marginTop: 8 }}
                                placeholder="Scorekeepers"
                                options={found.map((f) => ({
                                    value: f,
                                    label: f,
                                }))}
                                onChange={setAddress}
                            />
                        )}
                        {found && found.length === 0 && (
                            <Text type="secondary">None found</Text>
                        )}
                        {ftcStatus?.connected &&
                            ftcStatus.address === address && (
                                <Text type="secondary">
                                    {ftcStatus.eventName} ·{' '}
                                    {ftcStatus.eventCode}
                                </Text>
                            )}
                    </Form.Item>
                )}
            </Form>
        </Modal>
    );
}
