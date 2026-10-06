import { Button } from 'antd';
import { WarningFilled } from '@ant-design/icons';
import { isAlerting } from '../../models/Checks';
import useChecks, { ignoreCheck } from '../hooks/checks';
import { openChecks } from './ChecksDialog';
import CheckFixButton from './CheckFixButton';
import './CheckBanner.css';

// A bar at the top of every page for each failing check that is not
// ignored. It stays up only while the problem lasts.
export default function CheckBanner() {
    const checks = useChecks();
    const alerts = (checks ?? []).filter(isAlerting);
    if (!alerts.length) return null;
    return (
        <div className="check-banner">
            {alerts.map((c) => (
                <div
                    key={c.id}
                    className={`check-banner__row check-banner__row--${c.state}`}
                >
                    <WarningFilled />
                    <button
                        type="button"
                        className="check-banner__text"
                        onClick={openChecks}
                    >
                        <strong>{c.label}</strong>
                        <span>{c.detail}</span>
                    </button>
                    <CheckFixButton check={c} />
                    <Button size="small" onClick={() => ignoreCheck(c.id)}>
                        Ignore
                    </Button>
                </div>
            ))}
        </div>
    );
}
