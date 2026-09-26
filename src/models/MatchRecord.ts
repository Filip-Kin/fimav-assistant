import { TournamentLevel } from './FMSMatchState';

// A single team's participation in a recorded match, including any card issued
export interface MatchTeam {
    teamNumber: number;
    // Team nickname as FMS has it (trimmed); null when FMS gave none.
    // Absent on records written before names were captured.
    teamName?: string | null;
    // Effective card for THIS match (from FMS cardEffectiveStatus). A carried
    // yellow from a previous match is not reflected here (see FmsApi).
    card: 'None' | 'Yellow' | 'Red';
}

export type MatchRecordStatus = 'recording' | 'recorded' | 'error';

// Reserved for the v2 cutting step. Not populated yet.
export interface MatchProcessing {
    state: 'unprocessed' | 'queued' | 'processing' | 'done' | 'error';
    outputPath?: string;
    error?: string;
}

// Everything AutoAV knows about a match it recorded. Persisted to the
// 'recordings' store and surfaced in the Auto AV tab.
export interface MatchRecord {
    id: string; // `${level}_${matchNumber}_${playNumber}_${startedAt}`
    level: TournamentLevel;
    matchNumber: number;
    playNumber: number;
    eventName: string;
    eventCode: string | null;
    fileName: string | null;
    filePath: string | null;
    saveFolder: string | null;
    startedAt: number; // epoch ms (record start)
    endedAt: number | null; // epoch ms (record stop)
    status: MatchRecordStatus;
    error?: string;

    // v2 metadata (captured now, after the file is renamed)
    teams?: { red: MatchTeam[]; blue: MatchTeam[] };
    hasCard?: boolean; // derived: any cardEffectiveStatus !== 'None'

    // v2 processing (reserved, not populated this session)
    processing?: MatchProcessing;

    // Owned by the youtube-tba-upload process, never written by FIM-AV. Present
    // so the match store preserves it verbatim through a read-modify-write of the
    // shared manifest instead of dropping it. See matchStore's locked writes.
    upload?: unknown;
}
