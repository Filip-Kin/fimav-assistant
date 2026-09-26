import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import log from 'electron-log';
import { MatchRecord } from '../../models/MatchRecord';
import { TournamentLevel } from '../../models/FMSMatchState';
import { DOUBLE_ELIM_FINAL_START, isDoubleElimFinal } from '../../utils/recording';

// The single source of truth for match + upload tracking, shared with the
// youtube-tba-upload Go sidecar. One database file lives IN the recording
// folder, beside the .mp4s (the same place the retired fimav-matches.json
// manifest used to sit). WAL mode lets both processes share it: many readers,
// one writer, with a busy timeout to ride out the moments both write.
//
// Column ownership is a hard contract (see youtube-tba-upload/INTEGRATION.md):
// FIM-AV writes ONLY the recording / identity / team columns; the sidecar
// writes ONLY the upload + operational columns. We upsert with
// ON CONFLICT(file_name) touching only our own columns, so we never clobber
// the sidecar's writes and it never clobbers ours.
const DB_FILE = 'youtube-tba-upload.db';

// Identical to youtube-tba-upload/db.go `schema`. Whichever process opens the
// folder first creates the tables; CREATE TABLE IF NOT EXISTS makes it
// idempotent. Do NOT change these definitions without changing the Go side —
// the schema is locked.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
    file_name            TEXT PRIMARY KEY,
    file_path            TEXT,
    record_id            TEXT,
    event                TEXT,
    level                TEXT,
    match_number         INTEGER,
    play                 INTEGER,
    tba_match_key        TEXT,
    match_label          TEXT,
    record_status        TEXT,
    has_card             INTEGER,
    ended_at             INTEGER,
    teams_json           TEXT,
    processing_state     TEXT,
    processing_output    TEXT,
    processing_error     TEXT,
    upload_status        TEXT,
    yt_video_id          TEXT,
    yt_url               TEXT,
    tba_submitted        INTEGER,
    tba_error            TEXT,
    title_used           TEXT,
    uploaded_at          TEXT,
    size                 INTEGER,
    mtime                INTEGER,
    stable_since         INTEGER,
    attempts             INTEGER,
    next_attempt         INTEGER,
    last_error           TEXT,
    warnings_json        TEXT,
    hold_reason          TEXT,
    changed_after_upload INTEGER,
    updated_at           TEXT
);
CREATE TABLE IF NOT EXISTS upload_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    event_key   TEXT,
    config_json TEXT
);
CREATE TABLE IF NOT EXISTS upload_manual_video_ids (
    match_key   TEXT PRIMARY KEY,
    yt_video_id TEXT
);
CREATE TABLE IF NOT EXISTS upload_kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

// One open handle per recording folder. An event is a folder; a new event is a
// new folder, so we just open a fresh handle when the folder changes and keep
// the old one (the process is short-lived and event-scoped). Reads on a folder
// that doesn't exist yet return empty, matching the old JSON behaviour.
const handles = new Map<string, Database.Database>();

function getDb(
    folder: string,
    { create }: { create: boolean }
): Database.Database | null {
    const resolved = path.resolve(folder);
    const existing = handles.get(resolved);
    if (existing) return existing;
    try {
        if (!fs.existsSync(resolved)) {
            if (!create) return null;
            fs.mkdirSync(resolved, { recursive: true });
        }
        const db = new Database(path.join(resolved, DB_FILE));
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        db.pragma('synchronous = NORMAL');
        db.exec(SCHEMA);
        handles.set(resolved, db);
        return db;
    } catch (e) {
        log.error(`Failed to open match database in ${resolved}`, e);
        return null;
    }
}

// Close every open handle (used on quit so WAL settles cleanly).
export function closeAll(): void {
    handles.forEach((db, key) => {
        try {
            db.close();
        } catch (e) {
            log.warn(`Failed to close match database ${key}`, e);
        }
    });
    handles.clear();
}

// ── identity mapping ──────────────────────────────────────────────────────
// FIM-AV knows a match as its FMS (Level, MatchNumber, PlayNumber). The sidecar
// keys everything off the canonical TBA identity it would derive from the
// generated filename, and it sets the identity columns ONLY when it bootstraps
// a row — it never updates them on conflict. So FIM-AV must write the SAME
// canonical values the sidecar would parse from the file it just wrote, or the
// sidecar's titles/descriptions/TBA submission go out wrong. Mirrors
// youtube-tba-upload/parse.go + tbakey.go against the in-season filename
// (QM/SF{n}M1/F1M{n}/zz_PR/zz_TM) that utils/recording.ts produces.
function canonicalIdentity(
    level: TournamentLevel,
    matchNumber: number
): { level: string; number: number } {
    switch (level) {
        case 'Qualification':
            return { level: 'Qualification', number: matchNumber };
        case 'Practice':
            return { level: 'Practice', number: matchNumber };
        case 'Match Test':
            return { level: 'Test', number: matchNumber };
        case 'Playoff':
            // FMS numbers the 13 double-elim matches 1-13 and the finals from
            // 14 up; the sidecar sees finals as their own level via the F1M
            // token, so split them off here too.
            if (isDoubleElimFinal(matchNumber)) {
                return {
                    level: 'Final',
                    number: matchNumber - (DOUBLE_ELIM_FINAL_START - 1),
                };
            }
            return { level: 'Playoff', number: matchNumber };
        default:
            return { level: String(level), number: matchNumber };
    }
}

// Partial TBA match key (no event prefix), matching tbakey.go. Play is ignored
// (a replay is the same match). Practice/Test/unknown have no key.
function tbaMatchKey(canonLevel: string, canonNumber: number): string {
    switch (canonLevel.toLowerCase()) {
        case 'qualification':
            return `qm${canonNumber}`;
        case 'final':
            return `f1m${canonNumber}`;
        case 'playoff':
            // 8-team double elim: matches 1-13 are sf{n}m1 (finals already
            // split off above). Anything else has no key.
            if (canonNumber >= 1 && canonNumber <= 13) {
                return `sf${canonNumber}m1`;
            }
            return '';
        default:
            return '';
    }
}

// Recover FIM-AV's identity from record_id. The id is
// `${Level}_${MatchNumber}_${PlayNumber}_${startedAt}`; a Level like
// "Match Test" contains a space but never an underscore, so the last three
// underscore-separated fields are always the numbers and the rest is the level.
// This is why identity is read back from record_id and NOT from the level /
// match_number columns, which hold the sidecar-canonical values instead.
function parseRecordId(id: string): {
    level: TournamentLevel;
    matchNumber: number;
    playNumber: number;
    startedAt: number;
} {
    const parts = id.split('_');
    const startedAt = Number(parts[parts.length - 1]);
    const playNumber = Number(parts[parts.length - 2]);
    const matchNumber = Number(parts[parts.length - 3]);
    const level = parts.slice(0, parts.length - 3).join('_');
    return {
        level: level as TournamentLevel,
        matchNumber,
        playNumber,
        startedAt,
    };
}

// The FIM-AV-owned columns as a flat row, for parameter binding.
interface FimavColumns {
    file_name: string | null;
    file_path: string | null;
    record_id: string;
    event: string | null;
    level: string;
    match_number: number;
    play: number;
    tba_match_key: string;
    match_label: string;
    record_status: string;
    has_card: number | null;
    ended_at: number | null;
    teams_json: string | null;
    processing_state: string | null;
    processing_output: string | null;
    processing_error: string | null;
}

function recordToColumns(record: MatchRecord): FimavColumns {
    const { level: canonLevel, number: canonNumber } = canonicalIdentity(
        record.level,
        record.matchNumber
    );
    return {
        file_name: record.fileName ?? null,
        file_path: record.filePath ?? null,
        record_id: record.id,
        event: record.eventCode ?? null,
        level: canonLevel,
        match_number: canonNumber,
        play: record.playNumber,
        tba_match_key: tbaMatchKey(canonLevel, canonNumber),
        match_label: `${canonLevel} ${canonNumber}`,
        record_status: record.status,
        has_card: record.hasCard == null ? null : Number(record.hasCard),
        ended_at: record.endedAt ?? null,
        teams_json: record.teams ? JSON.stringify(record.teams) : null,
        processing_state: record.processing?.state ?? null,
        processing_output: record.processing?.outputPath ?? null,
        processing_error: record.processing?.error ?? null,
    };
}

// Reconstruct a MatchRecord from a row. Identity comes from record_id (see
// parseRecordId); note eventName and the record-level error string have no
// column in the locked schema, so eventName falls back to the event code and
// error is not round-tripped.
function rowToRecord(row: any, folder: string): MatchRecord {
    const parsed = parseRecordId(String(row.record_id));
    let teams: MatchRecord['teams'];
    if (row.teams_json) {
        try {
            teams = JSON.parse(row.teams_json);
        } catch (e) {
            log.warn('Failed to parse teams_json', e);
        }
    }
    let processing: MatchRecord['processing'];
    if (row.processing_state || row.processing_output || row.processing_error) {
        processing = {
            state: (row.processing_state ??
                'unprocessed') as NonNullable<
                MatchRecord['processing']
            >['state'],
            outputPath: row.processing_output ?? undefined,
            error: row.processing_error ?? undefined,
        };
    }
    return {
        id: String(row.record_id),
        level: parsed.level,
        matchNumber: parsed.matchNumber,
        playNumber: parsed.playNumber,
        eventName: row.event ?? '',
        eventCode: row.event ?? null,
        fileName: row.file_name ?? null,
        filePath: row.file_path ?? null,
        saveFolder: folder,
        startedAt: parsed.startedAt,
        endedAt: row.ended_at ?? null,
        status: (row.record_status ?? 'recorded') as MatchRecord['status'],
        teams,
        hasCard:
            row.has_card == null ? undefined : row.has_card === 1,
        processing,
    };
}

const FIMAV_COLS =
    'file_name, file_path, record_id, event, level, match_number, play, ' +
    'tba_match_key, match_label, record_status, has_card, ended_at, ' +
    'teams_json, processing_state, processing_output, processing_error';
const FIMAV_VALUES =
    '@file_name, @file_path, @record_id, @event, @level, @match_number, @play, ' +
    '@tba_match_key, @match_label, @record_status, @has_card, @ended_at, ' +
    '@teams_json, @processing_state, @processing_output, @processing_error';
// Only FIM-AV-owned columns; never upload_* / operational columns.
const FIMAV_UPDATE_SET = [
    'file_path',
    'record_id',
    'event',
    'level',
    'match_number',
    'play',
    'tba_match_key',
    'match_label',
    'record_status',
    'has_card',
    'ended_at',
    'teams_json',
    'processing_state',
    'processing_output',
    'processing_error',
]
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

// Write a record's FIM-AV columns. When the file has a name we upsert on the
// file_name PK (claiming a row the sidecar may have bootstrapped, without
// touching its columns). A record with no filename yet (a rename that failed
// before the file was filed) can't use the PK, so we locate it by record_id.
function writeRecord(db: Database.Database, record: MatchRecord): void {
    const cols = recordToColumns(record);
    if (cols.file_name != null) {
        db.prepare(
            `INSERT INTO matches (${FIMAV_COLS}) VALUES (${FIMAV_VALUES})
             ON CONFLICT(file_name) DO UPDATE SET ${FIMAV_UPDATE_SET}`
        ).run(cols as any);
        return;
    }
    const found = db
        .prepare('SELECT rowid AS rid FROM matches WHERE record_id = ?')
        .get(cols.record_id) as { rid: number } | undefined;
    if (found) {
        const set = [
            'file_path',
            'event',
            'level',
            'match_number',
            'play',
            'tba_match_key',
            'match_label',
            'record_status',
            'has_card',
            'ended_at',
            'teams_json',
            'processing_state',
            'processing_output',
            'processing_error',
        ]
            .map((c) => `${c} = @${c}`)
            .join(', ');
        db.prepare(`UPDATE matches SET ${set} WHERE rowid = @rid`).run({
            ...cols,
            rid: found.rid,
        } as any);
    } else {
        db.prepare(
            `INSERT INTO matches (${FIMAV_COLS}) VALUES (${FIMAV_VALUES})`
        ).run(cols as any);
    }
}

// ── public helpers (used by matchStore.ts) ─────────────────────────────────

// Every FIM-AV match record in a folder (rows the sidecar merely bootstrapped
// for hand-placed files have no record_id and are excluded), newest first.
export function listRecords(folder: string): MatchRecord[] {
    const db = getDb(folder, { create: false });
    if (!db) return [];
    try {
        const rows = db
            .prepare('SELECT * FROM matches WHERE record_id IS NOT NULL')
            .all();
        return rows
            .map((r) => rowToRecord(r, folder))
            .sort((a, b) => b.startedAt - a.startedAt);
    } catch (e) {
        log.warn('listRecords failed', e);
        return [];
    }
}

// One record by record_id, or null.
export function getRecord(folder: string, id: string): MatchRecord | null {
    const db = getDb(folder, { create: false });
    if (!db) return null;
    try {
        const row = db
            .prepare('SELECT * FROM matches WHERE record_id = ?')
            .get(id);
        return row ? rowToRecord(row, folder) : null;
    } catch (e) {
        log.warn('getRecord failed', e);
        return null;
    }
}

// Insert a record or replace the FIM-AV columns of the row with the same
// identity.
export function putRecord(folder: string, record: MatchRecord): void {
    const db = getDb(folder, { create: true });
    if (!db) return;
    try {
        writeRecord(db, record);
    } catch (e) {
        log.error('putRecord failed', e);
    }
}

// Merge a partial patch into an existing record and persist it. Returns the
// updated record, or null when no record with that id exists in the folder.
export function patchRecord(
    folder: string,
    id: string,
    patch: Partial<MatchRecord>
): MatchRecord | null {
    const current = getRecord(folder, id);
    if (!current) {
        log.warn(`patchRecord: no record ${id} in ${folder}`);
        return null;
    }
    const merged: MatchRecord = { ...current, ...patch };
    putRecord(folder, merged);
    return merged;
}

// A match row with the sidecar's upload columns folded in, for a tab that wants
// to read upload state straight from the shared database (the Upload tab reads
// the sidecar's HTTP API instead, but this keeps everything in one store).
export interface MatchWithUpload extends MatchRecord {
    upload: {
        status: string | null;
        ytVideoId: string | null;
        ytUrl: string | null;
        tbaSubmitted: boolean;
        tbaError: string | null;
        titleUsed: string | null;
        uploadedAt: string | null;
        attempts: number | null;
        lastError: string | null;
        holdReason: string | null;
        changedAfterUpload: boolean;
    };
}

export function listRecordsWithUpload(folder: string): MatchWithUpload[] {
    const db = getDb(folder, { create: false });
    if (!db) return [];
    try {
        const rows = db
            .prepare('SELECT * FROM matches WHERE record_id IS NOT NULL')
            .all() as any[];
        return rows
            .map((r) => ({
                ...rowToRecord(r, folder),
                upload: {
                    status: r.upload_status ?? null,
                    ytVideoId: r.yt_video_id ?? null,
                    ytUrl: r.yt_url ?? null,
                    tbaSubmitted: r.tba_submitted === 1,
                    tbaError: r.tba_error ?? null,
                    titleUsed: r.title_used ?? null,
                    uploadedAt: r.uploaded_at ?? null,
                    attempts: r.attempts ?? null,
                    lastError: r.last_error ?? null,
                    holdReason: r.hold_reason ?? null,
                    changedAfterUpload: r.changed_after_upload === 1,
                },
            }))
            .sort((a, b) => b.startedAt - a.startedAt);
    } catch (e) {
        log.warn('listRecordsWithUpload failed', e);
        return [];
    }
}
