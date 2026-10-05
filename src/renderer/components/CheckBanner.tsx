import { Button } from 'antd';
import { WarningFilled } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { isAlerting } from '../../models/Checks';
import useChecks, { ignoreCheck } from '../hooks/checks';
import './CheckBanner.css';

// A bar at the top of every page for each failing check that is not
// ignored. It stays up only while the problem lasts.
export default function CheckBanner() {
    const checks = useChecks();
    const nav = useNavigate();
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
                        onClick={() => nav('/checks')}
                    >
                        <strong>{c.label}</strong>
                        <span>{c.detail}</span>
                    </button>
                    <Button size="small" onClick={() => ignoreCheck(c.id)}>
                        Ignore 6 h
                    </Button>
                </div>
            ))}
        </div>
    );
}
