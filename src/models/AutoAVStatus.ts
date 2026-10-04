import { FileNameMode } from '../utils/recording';

// Snapshot of AutoAV's health, surfaced in the Auto AV tab so a volunteer can
// tell at a glance whether recording is actually working.
export interface AutoAVStatus {
    // Whether the AutoAV addon thread is running
    running: boolean;
    // Connected to the FMS SignalR hub
    fmsConnected: boolean;
    // vMix reachability + whether it is currently recording
    vmix: { reachable: boolean; recording: boolean };
    // Whether AutoAV itself kicked off the current recording
    recordingActive: boolean;
    // The event AutoAV detected as currently running
    currentEvent: { name: string; code: string | null } | null;
    // Folder recordings are filed into (the effective event folder)
    saveFolder: string | null;
    // Effective file naming mode for this event. Also the season switch: the
    // off-season-only features (YouTube uploader, Upload tab, dead-time cutting)
    // exist only in off-season mode.
    fileNameMode: FileNameMode;
    // True when the event itself sets the mode (official = in-season,
    // unofficial = off-season), so the stored fallback setting does nothing.
    fileNameModeForced: boolean;
    // Example output filename for the current event + naming mode
    sampleFileName: string;
    // Last human-readable status line (mirrors the footer)
    lastMessage: string | null;
}
