// Match State
type MatchState =
    | 'NoCurrentlyActiveEvent'
    | 'NoCurrentlyActiveTournamentLevel'
    | 'WaitingForPrestart'
    | 'WaitingForPrestartTO'
    | 'Prestarting'
    | 'PrestartingTO'
    | 'WaitingForSetAudience'
    | 'WaitingForSetAudienceTO'
    | 'WaitingForMatchReady'
    | 'WaitingForMatchStart'
    | 'GameSpecificData'
    | 'MatchAuto'
    | 'MatchTransition'
    | 'MatchTeleop'
    | 'WaitingForCommit'
    | 'WaitingForPostResults'
    | 'TournamentLevelComplete'
    | 'MatchCancelled'
    | 'WaitingForMatchPreview'
    | 'WaitingForMatchPreviewTO';

export type TournamentLevel =
    | 'Practice'
    | 'Qualification'
    | 'Playoff'
    | 'Match Test';

// P1: Match State (String), P2: Match Number (Number), P3: Play Number (Number), P4: Level (String)
type FMSMatchStatus = {
    MatchState: MatchState;
    MatchNumber: number;
    PlayNumber: number;
    Level: TournamentLevel;
    // FTC only: the scorekeeper's own match name (e.g. "Q3"), used in file
    // names instead of FRC's numbering, which does not fit FTC playoffs.
    ShortName?: string;
};

export default FMSMatchStatus;
