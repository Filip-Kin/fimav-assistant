import { MatchRecord } from '../../models/MatchRecord';
import {
    listRecords,
    getRecord,
    putRecord,
    patchRecord,
} from './db';

// Per-event match state lives in the shared SQLite database
// (youtube-tba-upload.db) IN the recording folder, beside the videos, not in a
// global app store. That way the Auto AV tab's history simply reflects whatever
// folder the app is currently pointed at: a new event means a new folder, which
// means a fresh (empty) history, with no manual clearing needed. This used to
// be a fimav-matches.json manifest; it moved to the database so FIM-AV and the
// youtube-tba-upload sidecar read and write one store (see db.ts and
// youtube-tba-upload/INTEGRATION.md). The public functions and the MatchRecord
// shape are unchanged, so every caller (AutoAV) keeps working.

// All recorded matches in a folder, newest first. Empty when the folder is
// unknown or has no database yet.
export function listMatches(folder: string | null): MatchRecord[] {
    if (!folder) return [];
    return listRecords(folder);
}

// One record by id, or null.
export function getMatch(folder: string | null, id: string): MatchRecord | null {
    if (!folder) return null;
    return getRecord(folder, id);
}

// Insert a new record or replace an existing one with the same id.
export function upsertMatch(folder: string, record: MatchRecord): void {
    putRecord(folder, record);
}

// Merge a partial patch into an existing record. Returns the updated record, or
// null if no record with that id exists in this folder.
export function updateMatch(
    folder: string,
    id: string,
    patch: Partial<MatchRecord>
): MatchRecord | null {
    return patchRecord(folder, id, patch);
}
