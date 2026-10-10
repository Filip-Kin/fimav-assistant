import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import glob from 'glob';
import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import log from 'electron-log';
import {
    EquipmentLogCategory,
    EquipmentLogDetails,
    EquipmentLogType,
} from '../../models/EquipmentLog';
import FMSMatchStatus from '../../models/FMSMatchState';
import FtcScorekeeper from '../ftc/scorekeeper';
import FtcRecorder from '../ftc/recorder';
import { FtcScorekeeperStatus, FtcUpdate } from '../../models/Ftc';
import attemptRename, {
    FileNameMode,
    eventFolderName,
    sampleFileName,
} from '../../utils/recording';
import { AddonLoggers } from './addon-loggers';
import { getCurrentEvent, signalrToElectronLog } from '../util';
import VmixService from '../../services/VmixService';
import FmsApi from '../../services/FmsApi';
import Event from '../../models/Event';
import { AutoAVStatus, Program } from '../../models/AutoAVStatus';
import { MatchRecord } from '../../models/MatchRecord';
import {
    upsertMatch,
    updateMatch,
    getMatch,
    listMatches,
} from '../recordings/matchStore';
import cutMatchVideo, { enqueueCut } from '../cutMatch';
import { queueLoudness } from '../checks/loudness';
import { getStore } from '../store';
import { invokeExpectResponse, invokeLog } from '../window_components/signalR';

// Events AutoAV emits to the renderer: a human status line, a structured
// status snapshot, a single match-record upsert, and the full match list for
// the current event folder, plus eventChanged when the field system (FMS or
// the FTC scorekeeper) moves to a different event (see noteEvent).
export type AutoAVEvent =
    | 'info'
    | 'status'
    | 'match'
    | 'matches'
    | 'eventChanged'
    // FMS / FTC Live match state changed: the checks re-run at once, so the
    // match start sound is sampled from the start, not up to 5 s late.
    | 'play';

export default class AutoAV {
    private static instance: AutoAV;

    // Match data from the last time the match started
    private lastMatchStartData: FMSMatchStatus | null = null;

    // Last match state received
    private lastState: FMSMatchStatus | null = null;

    // SignalR Hub Connection
    private hubConnection: HubConnection | null = null;

    // Loggers
    private logs: AddonLoggers | null = null;

    // Last file recorded
    private currentFile: string | null = null;

    // Current event name
    private currentEvent: Event | null = null;

    // The FTC scorekeeper's event. Kept apart from currentEvent (fim-admin)
    // so it only names and sets the season of recordings in FTC mode.
    private ftcEvent: Event | null = null;

    // Track whether or not we're recording (rather than someone in vMix clicking record)
    public weAreRecording = false;

    // Track if we're already scheduled to stop recording
    private willStopRecording = false;

    // Event Emitter
    private emitter: EventEmitter = new EventEmitter();

    // Structured status surfaced to the Auto AV tab
    private status: AutoAVStatus = {
        running: false,
        fmsConnected: false,
        vmix: { reachable: false, recording: false },
        recordingActive: false,
        currentEvent: null,
        saveFolder: null,
        fileNameMode: 'in-season',
        fileNameModeForced: false,
        season: 'in-season',
        ftcConnected: false,
        program: 'frc',
        programDetected: null,
        frcAudienceDisplay: 'fms',
        audienceDisplay: 'fms',
        sampleFileName: '',
        lastMessage: null,
    };

    // Id of the MatchRecord for the in-progress recording, so we can patch it on stop
    private currentRecordId: string | null = null;

    // The in-progress record itself. It isn't persisted until the recording
    // stops (we don't know the destination folder for its manifest until then),
    // so we hold it here and write it once the file is filed.
    private currentRecordObj: MatchRecord | null = null;

    // Periodic vMix reachability poll
    private vmixPollTimer: ReturnType<typeof setInterval> | null = null;

    private fmsEventTimer: ReturnType<typeof setInterval> | null = null;

    // vMix's configured recording folder, cached from the poll so emitStatus can
    // show the exact save path before the first recording.
    private vmixRecordFolder: string | null = null;

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope('autoav.out'),
            err: log.scope('autoav.err'),
        };
    }

    /**
     * Stop recording
     * @returns void
     */
    private async stopRecording() {
        // Check if we're recording
        if (!(await VmixService.Instance.isRecording())) {
            this.logRecording(
                '🟥 Not Recording',
                undefined,
                EquipmentLogType.Debug
            );
            return;
        }

        VmixService.Instance.StopRecording()
            .then(async () => {
                this.logRecording('🟥 Stopped Recording');
                this.weAreRecording = false;
                this.willStopRecording = false;
                this.status.recordingActive = false;
                this.status.vmix.recording = false;
                this.emitStatus();

                // If we don't have a start time or data, don't try to rename
                if (!this.lastMatchStartData) return undefined;

                // Local handles to this match's state, taken before any await:
                // the file can take up to a minute to finish, and the next
                // match may start (and set these fields) meanwhile.
                const matchData = this.lastMatchStartData;
                const recordId = this.currentRecordId;
                const recordObj = this.currentRecordObj;
                const file = this.currentFile;

                // If we don't have an event name, try to get it
                if (!this.currentEvent) {
                    this.logRecording(
                        'ℹ Event not Present. Fetching current event...',
                        undefined,
                        EquipmentLogType.Warn
                    );
                    this.currentEvent = await this.fetchEvent();
                    this.emitStatus();
                }

                // Attempt to rename the file
                try {
                    const filename = await attemptRename(
                        this.currentEvent,
                        file,
                        matchData
                    );

                    this.logRecording(
                        `Renamed last recording to ${path.basename(filename)}`
                    );

                    // Persist the finished record into the manifest that lives
                    // in the event folder the file was filed into.
                    if (recordId && recordObj) {
                        const saveFolder = path.dirname(filename);
                        this.status.saveFolder = saveFolder;
                        const record: MatchRecord = {
                            ...recordObj,
                            fileName: path.basename(filename),
                            filePath: filename,
                            saveFolder,
                            endedAt: Date.now(),
                            status: 'recorded',
                        };
                        upsertMatch(saveFolder, record);
                        this.emitter.emit('match', record);
                        this.emitStatus();

                        // Capture teams + cards first, so the card rule below can
                        // be honoured. Best-effort: a failed fetch never risks
                        // the file, and only means we can't confirm cards.
                        const hasCard = await this.captureMetadata(
                            saveFolder,
                            recordId,
                            matchData
                        );

                        // Auto-cut the dead time in place (original moved to
                        // Originals/), if enabled. Never cut a match with a card:
                        // the card explanation lives in the dead time we'd remove.
                        if (
                            this.isFrcOffSeason() &&
                            getStore().get('autoAv.autoCut', false) &&
                            hasCard !== true
                        ) {
                            // Loudness is measured once the cut is made.
                            this.queueCut(saveFolder, recordId);
                        } else {
                            queueLoudness(saveFolder, recordId, filename, (r) =>
                                this.emitter.emit('match', r)
                            );
                        }
                    }
                } catch (err: any) {
                    this.logRecording(
                        `‼️ Error Renaming Recording`,
                        err,
                        EquipmentLogType.Error
                    );
                    // The file was never filed, so there's no folder/manifest to
                    // write to. Persist the error record if we have a folder,
                    // else just surface it live.
                    if (recordId && recordObj) {
                        const errored: MatchRecord = {
                            ...recordObj,
                            status: 'error',
                            error: String(err?.message ?? err),
                            endedAt: Date.now(),
                        };
                        if (this.status.saveFolder) {
                            upsertMatch(this.status.saveFolder, errored);
                        }
                        this.emitter.emit('match', errored);
                    }
                } finally {
                    // Only if no newer match has taken these over.
                    if (this.currentRecordId === recordId) {
                        this.lastMatchStartData = null;
                        this.currentRecordId = null;
                        this.currentRecordObj = null;
                    }
                }

                return undefined;
            })
            .catch((err) => {
                this.logRecording(
                    `‼️ Error Stopping Recording`,
                    err,
                    EquipmentLogType.Error
                );
            });
    }

    /**
     * Start Recording
     * @returns void
     */
    private startRecording(matchInfo: FMSMatchStatus) {
        VmixService.Instance.StartRecording()
            .then(() => {
                this.logRecording(
                    `🔴 Started Recording ${matchInfo.Level} Match #${matchInfo.MatchNumber}-${matchInfo.PlayNumber}`
                );
                this.lastMatchStartData = matchInfo;
                this.weAreRecording = true;

                // Create a record for this match so it shows in the Auto AV tab
                const startedAt = Date.now();
                const record: MatchRecord = {
                    id: `${matchInfo.Level}_${matchInfo.MatchNumber}_${matchInfo.PlayNumber}_${startedAt}`,
                    level: matchInfo.Level,
                    matchNumber: matchInfo.MatchNumber,
                    playNumber: matchInfo.PlayNumber,
                    eventName: this.currentEvent?.name ?? 'Unknown Event',
                    eventCode: this.currentEvent?.code ?? null,
                    fileName: null,
                    filePath: null,
                    saveFolder: null,
                    startedAt,
                    endedAt: null,
                    status: 'recording',
                };
                this.currentRecordId = record.id;
                this.currentRecordObj = record;
                // Not persisted yet: the destination folder (and thus which
                // manifest to write) isn't known until the file is filed on
                // stop. Emit it live so the tab shows it recording.
                this.emitter.emit('match', record);

                this.status.recordingActive = true;
                this.status.vmix.recording = true;
                this.emitStatus();

                // Give it some time, then attempt to find the file
                setTimeout(async () => {
                    this.currentFile =
                        await VmixService.Instance.GetCurrentRecording();
                }, 3000);

                return undefined;
            })
            .catch((err) => {
                this.logRecording(
                    `‼️ Error Starting Recording. Is Vmix at ${VmixService.Instance.getUrl()}?`,
                    err,
                    EquipmentLogType.Error
                );
            });
    }

    // #region FTC

    private ftcListening = false;

    // FTC recording: match plus score reveal, cut from vMix raw files.
    private ftcRecorder = new FtcRecorder({
        event: () => this.event(),
        folder: () => this.status.saveFolder,
        log: (m) => this.logRecording(m),
        setRecording: (on) => {
            // weAreRecording also tells the auto-updater not to restart now.
            this.weAreRecording = on;
            this.status.recordingActive = on;
            this.status.vmix.recording = on;
            this.emitStatus();
        },
        record: (rec) => this.emitter.emit('match', rec),
    });

    // A qualification or playoff match being played right now, FRC or FTC,
    // for the stream checks; null between matches and for practice/test.
    public matchInPlay(): { label: string; level: string } | null {
        if (this.isFtc()) {
            const m = this.ftcRecorder.inPlay();
            if (!m || !['Qualification', 'Playoff'].includes(m.level))
                return null;
            return { label: m.shortName, level: m.level };
        }
        const st = this.lastState;
        if (
            !st ||
            !['Qualification', 'Playoff'].includes(st.Level) ||
            ![
                'GameSpecificData',
                'MatchAuto',
                'MatchTransition',
                'MatchTeleop',
            ].includes(st.MatchState)
        )
            return null;
        const prefix = st.Level === 'Qualification' ? 'Q' : 'P';
        return { label: `${prefix}${st.MatchNumber}`, level: st.Level };
    }

    public ftcRecorderSummary() {
        return this.ftcRecorder.summary();
    }

    private onFtcUpdate(u: FtcUpdate) {
        if (!this.isFtc()) return;
        this.ftcRecorder.onUpdate(u);
        this.emitter.emit('play');
    }

    // A new FTC event fills in the event name like a new FMS event does, and
    // is the event in FTC mode unless fim-admin names a different one.
    private onFtcStatus(s: FtcScorekeeperStatus) {
        // Connecting or dropping can change the detected program.
        if (!s.eventCode) {
            this.emitStatus();
            return;
        }
        this.ftcEvent = {
            code: s.eventCode,
            name: s.eventName || s.eventCode,
            // Off-season events report "Non-Advancement" (FTC Live 8.0);
            // scrimmages and off-season types are not official either.
            isOfficial: !/NON-?ADVANCEMENT|OFF|SCRIM/i.test(s.eventType ?? ''),
        } as Event;
        // Program detection first: the scorekeeper's event only counts as a
        // new event in FTC mode (see checkFmsEvent).
        this.emitStatus();
        if (this.isFtc()) {
            this.noteEvent('ftc', s.eventCode, s.eventName || s.eventCode);
            // Finish matches left from before a restart.
            this.ftcRecorder.resume();
        }
        this.emitStatus();
        this.emitMatches();
    }

    // #endregion

    // Start AutoAV
    public start() {
        if (!this.ftcListening) {
            this.ftcListening = true;
            FtcScorekeeper.Instance.on('update', (u: FtcUpdate) =>
                this.onFtcUpdate(u)
            );
            FtcScorekeeper.Instance.on('status', (s: FtcScorekeeperStatus) =>
                this.onFtcStatus(s)
            );
        }

        // Notify Parent logs that we're running
        this.log('AutoAV Service Started', undefined, true);

        this.status.running = true;
        this.emitStatus();

        // Begin polling vMix reachability for the status tab
        this.startVmixPoll();

        // Follow the event FMS is set up for
        this.startFmsEventPoll();

        // Build a connection to the SignalR Hub
        this.hubConnection = new HubConnectionBuilder()
            .withUrl('http://10.0.100.5/infrastructureHub')
            .withServerTimeout(30000) // 30 seconds, per FMS Audience Display
            .withKeepAliveInterval(15000) // 15 seconds per FMS Audience Display
            .configureLogging({
                log: (logLevel, message) => {
                    signalrToElectronLog(
                        this.logs?.out ?? null,
                        logLevel,
                        message
                    );
                },
            })
            // .withHubProtocol(new MessagePackHubProtocol())
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds(retryContext) {
                    log.warn('Retrying SignalR connection...');
                    return Math.min(
                        2_000 * retryContext.previousRetryCount,
                        120_000
                    );
                },
            })
            .build();

        // Register listener for the "MatchStatusInfoChanged" event (match starts, ends, changes modes, etc)
        this.hubConnection.on(
            'MatchStatusInfoChanged',
            (info: FMSMatchStatus) => {
                // Log the change
                this.logFMS(
                    `Match Status Changed: ${
                        this.lastState ? this.lastState.MatchState : 'Unknown'
                    } -> ${info.MatchState} for ${info.Level} Match ${
                        info.MatchNumber
                    } (Play #${info.PlayNumber})`,
                    info,
                    EquipmentLogType.Debug
                );

                // Update
                this.lastState = info;
                this.emitter.emit('play');

                // At FTC events FTC Live drives recording, even when an FMS
                // is also on the network.
                if (this.isFtc()) return;

                // Start recording when GameSpecificData is released (match starts)
                if (info.MatchState === 'GameSpecificData') {
                    this.startRecording(info);
                } else if (info.MatchState === 'MatchCancelled') {
                    // Estop!
                    this.willStopRecording = true;
                    setTimeout(() => this.stopRecording(), 10000); // Ok, but we wanna see the frantic running around for a bit
                } else if (
                    [
                        'Prestarting',
                        'PrestartingTO',
                        'WaitingForPrestart',
                        'WaitingForPrestartTO',
                    ].includes(info.MatchState) &&
                    !this.willStopRecording // Don't stop recording if we're already stopping
                ) {
                    // Probably skipped showing results.  Stop recording as results won't be shown
                    this.willStopRecording = true;
                    setTimeout(() => this.stopRecording(), 10000);
                }
            }
        );

        // Register listener for the "SystemConfigValueChanged" event (video switch))
        this.hubConnection.on('SystemConfigValueChanged', async (configKey) => {
            this.logFMS(
                `Got a config value change`,
                { key: configKey },
                EquipmentLogType.Debug
            );

            // VideoSwitchOption
            if (configKey === 'VideoSwitchOption' && !this.isFtc()) {
                this.logFMS(
                    'Video switch option changed, fetching update!',
                    undefined,
                    EquipmentLogType.Debug
                );
                const resp = await nodeFetch(
                    'http://10.0.100.5/api/v1.0/settings/get/get_VideoSwitchOption'
                );
                const switchOption = await resp.text();
                this.logFMS(
                    `Got Switch Option: ${switchOption}`,
                    undefined,
                    EquipmentLogType.Debug
                );
                // "MatchResult" (yes, double quotes are included in the response)
                if (switchOption === '"MatchResult"') {
                    this.logFMS(
                        '🚀 Scores Posted. Waiting 16 Seconds...',
                        undefined,
                        EquipmentLogType.Debug
                    );

                    // TODO: Make this time dynamic and configurable
                    this.willStopRecording = true;
                    setTimeout(() => this.stopRecording(), 16000); // As of 2024, the time to actually see the match details happens at about 11 seconds, so we'll wait 16 seconds to be safe
                }
            }
        });

        const bogusEvents = [
            'fieldnetworkstatus',
            'matchtimerchanged',
            'plc_io_status_changed',
            'plc_match_status_changed',
            'plc_connection_status_changed',
            'robotversiondatachanged',
            'azuresyncprogress',
            'azuresyncstatuschanged',
        ];

        // Dummies to get log to shush
        bogusEvents.forEach((e) => {
            this.hubConnection?.on(e, () => {});
        });

        // Register connected/disconnected events
        this.hubConnection.onreconnecting(() => {
            this.status.fmsConnected = false;
            this.emitStatus();
            this.logFMS(
                'AutoAV FMS Connection Lost, Reconnecting',
                undefined,
                EquipmentLogType.Warn,
                true
            );
        });
        this.hubConnection.onreconnected(() => {
            this.status.fmsConnected = true;
            this.emitStatus();
            this.checkFmsEvent();
        });
        this.hubConnection.onclose(() => {
            this.status.fmsConnected = false;
            this.emitStatus();
            this.logFMS(
                'AutoAV FMS Connection Closed!',
                undefined,
                EquipmentLogType.Warn,
                true
            );
        });

        // Start connection to SignalR Hub
        this.hubConnection
            .start()
            .then(() => {
                this.status.fmsConnected = true;
                this.emitStatus();
                this.checkFmsEvent();
                this.logFMS(
                    'FMS Connection Established!',
                    undefined,
                    undefined,
                    true
                );

                return undefined;
            })
            .catch((err) => {
                this.status.fmsConnected = false;
                this.emitStatus();
                this.logFMS(
                    `AutoAV FMS Connection Failed. Restarting...`,
                    err,
                    EquipmentLogType.Error,
                    true
                );

                setTimeout(() => {
                    // Restart AutoAV
                    this.stop();
                    this.start();
                }, 120_000);
            });
    }

    // Stop AutoAV
    public stop() {
        // Log stopping
        this.log('AutoAV Service Stopped');
        this.emitter.emit('info', 'Service Stopped');
        // Stop polling vMix
        this.stopVmixPoll();
        this.stopFmsEventPoll();
        this.status.running = false;
        this.status.fmsConnected = false;
        this.status.vmix = { reachable: false, recording: false };
        this.emitStatus();
        // Stop the SignalR Hub connection
        this.hubConnection?.stop();
    }

    /**
     * Stop recording (for development)
     * Fill in random info and stop recording
     */
    public devStopRecording() {
        if (!this.lastMatchStartData) {
            this.lastMatchStartData = {
                MatchState: 'GameSpecificData',
                Level: 'Qualification',
                MatchNumber: 1,
                PlayNumber: 1,
            };
        } else {
            this.lastMatchStartData = {
                MatchState: 'GameSpecificData',
                Level: 'Qualification',
                MatchNumber: this.lastMatchStartData.MatchNumber + 1,
                PlayNumber: 1,
            };
        }
        this.stopRecording();
    }

    public devStartRecording() {
        this.startRecording({
            MatchState: 'GameSpecificData',
            Level: 'Qualification',
            MatchNumber: this.lastMatchStartData
                ? this.lastMatchStartData.MatchNumber + 1
                : 1,
            PlayNumber: 1,
        });
    }

    // Fetch the event name
    private async fetchEvent(): Promise<Event | null> {
        return invokeExpectResponse<Event[]>('GetEvents', 'Events')
            .then((events: Event[]) => {
                return getCurrentEvent(events);
            })
            .then((e) => {
                return e ?? null;
            })
            .catch((e) => {
                this.log(`‼️ Error Fetching Event Name`, {
                    severity: EquipmentLogType.Error,
                    extraInfo: e,
                    category: EquipmentLogCategory.General,
                });
                return null;
            });
    }

    private logRecording(
        msg: string,
        extraInfo?: object,
        severity: EquipmentLogType = EquipmentLogType.Info,
        notifyClient = true
    ) {
        this.log(
            msg,
            {
                severity,
                extraInfo,
                category: EquipmentLogCategory.AutoAV_Recording,
            },
            notifyClient
        );
    }

    private logFMS(
        msg: string,
        extraInfo?: object,
        severity: EquipmentLogType = EquipmentLogType.Info,
        notifyClient = false
    ) {
        this.log(
            msg,
            { severity, extraInfo, category: EquipmentLogCategory.AutoAV_FMS },
            notifyClient
        );
    }

    // Log a message
    private log(
        msg: string,
        opts: EquipmentLogDetails = {
            severity: EquipmentLogType.Info,
            category: EquipmentLogCategory.AutoAV_General,
        },
        notifyClient = false
    ) {
        if (this.logs) {
            // Local log to file
            const localLog =
                opts.severity === EquipmentLogType.Error ||
                opts.severity === EquipmentLogType.Fatal
                    ? this.logs.err
                    : this.logs.out;
            localLog.log(msg + (opts.extraInfo ? `\n\t${opts.extraInfo}` : ''));
        }

        // Log to frontend
        if (notifyClient) {
            this.status.lastMessage = msg;
            this.emitter.emit('info', msg);
            this.emitStatus();
        }

        // Don't send debug to logging server, too verbose
        if (opts.severity === EquipmentLogType.Debug) return;

        // Log to backend
        try {
            invokeLog(msg, {
                severity: opts.severity,
                category: opts.category ?? EquipmentLogCategory.AutoAV_General,
                extraInfo: opts.extraInfo,
            });
        } catch (e) {
            this.logs?.err.error(`Failed to log message to backend: ${msg}`, e);
        }
    }

    // Set the event name
    public setEvent(event: Event | null) {
        this.currentEvent = event;
        this.emitStatus();
    }

    // The event recordings are named and seasoned by: fim-admin's, except in
    // FTC mode, where the scorekeeper's event stands in when fim-admin has
    // none or names the same event.
    private event(): Event | null {
        if (!this.isFtc() || !this.ftcEvent) return this.currentEvent;
        if (this.currentEvent && this.currentEvent.code !== this.ftcEvent.code)
            return this.currentEvent;
        return { ...(this.currentEvent ?? {}), ...this.ftcEvent } as Event;
    }

    // Apply settings changed from the Auto AV settings dialog: re-emit status
    // (picks up a new naming mode) and re-check vMix with the new connection.
    public applySettings(): void {
        this.emitStatus();
        // The save folder may have changed, so refresh the history to match.
        this.emitMatches();
        this.pollVmix();
    }

    // Effective file naming mode: official events are always in-season,
    // unofficial always off-season, otherwise fall back to the stored setting.
    private effectiveFileNameMode(): FileNameMode {
        const event = this.event();
        if (event?.isOfficial === false) return 'off-season';
        if (event?.isOfficial === true) return 'in-season';
        return getStore().get('autoAv.fileNameMode', 'in-season');
    }

    public isFtc(): boolean {
        return this.status.program === 'ftc';
    }

    // FRC off-season features: the custom audience display and dead-time
    // cutting (its keep-first-166-s rule is FRC match timing).
    public isFrcOffSeason(): boolean {
        return !this.isFtc() && this.isOffSeason();
    }

    // The custom audience display runs at FRC off-season events when it is
    // the chosen display in Settings.
    public runsCustomAd(): boolean {
        return (
            this.isFrcOffSeason() &&
            getStore().get('frcAudienceDisplay', 'fms') === 'customAd'
        );
    }

    // The YouTube uploader runs at FTC events in either season and at FRC
    // off-season events.
    public runsUploader(): boolean {
        return this.isFtc() || this.isOffSeason();
    }

    // Off-season turns on the off-season-only features: the YouTube uploader
    // and Upload tab, the custom audience display and dead-time cutting.
    // Detected, never set: an unofficial event is off-season, an official one
    // in-season. With no event, January to April is in-season and the rest of
    // the year off-season. File naming is separate and does not decide it.
    public isOffSeason(): boolean {
        const official = this.event()?.isOfficial;
        if (typeof official === 'boolean') return !official;
        return new Date().getMonth() > 3;
    }

    // Build and broadcast the current status snapshot
    private emitStatus() {
        const store = getStore();
        const nameOverride = store.get('autoAv.eventNameOverride', '').trim();
        const saveFolderOverride = store.get('autoAv.saveFolder', '').trim();

        // FRC or FTC. Detection: the scorekeeper answering and FMS not = FTC;
        // FMS answering = FRC; neither = keep what it was. Settings override.
        const ftcConnected = FtcScorekeeper.Instance.getStatus().connected;
        this.status.ftcConnected = ftcConnected;
        let detected: Program | null = null;
        if (ftcConnected && !this.status.fmsConnected) detected = 'ftc';
        else if (this.status.fmsConnected) detected = 'frc';
        this.status.programDetected = detected;
        const override = store.get('program', 'auto');
        this.status.program =
            override === 'frc' || override === 'ftc'
                ? override
                : detected ?? this.status.program;
        // The event actually used for naming: a typed override always wins.
        const effectiveEvent: Event | null = nameOverride
            ? ({
                  ...(this.event() ?? {}),
                  name: nameOverride,
                  code: nameOverride,
              } as Event)
            : this.event();

        this.status.currentEvent = effectiveEvent
            ? {
                  name: effectiveEvent.name,
                  code: effectiveEvent.code ?? null,
              }
            : null;
        this.status.fileNameMode = this.effectiveFileNameMode();
        this.status.season = this.isOffSeason() ? 'off-season' : 'in-season';
        this.status.frcAudienceDisplay =
            store.get('frcAudienceDisplay', 'fms') === 'customAd'
                ? 'customAd'
                : 'fms';
        if (this.isFtc()) this.status.audienceDisplay = 'ftcLive';
        else if (this.runsCustomAd()) this.status.audienceDisplay = 'customAd';
        else this.status.audienceDisplay = 'fms';
        this.status.fileNameModeForced =
            typeof this.event()?.isOfficial === 'boolean';
        this.status.sampleFileName = sampleFileName(
            effectiveEvent,
            this.status.fileNameMode
        );

        // Effective destination folder = base folder + the event subfolder for
        // the CURRENT effective event name. The event subfolder is always
        // recomputed from the name (not frozen to the last recording), so
        // changing the event name updates the shown path immediately. The base
        // is: an explicit save-folder override, else the parent of the last real
        // save folder, else vMix's configured record folder.
        let base: string | null = null;
        if (saveFolderOverride) {
            base = saveFolderOverride;
        } else {
            const last = store.get('autoAv.lastSaveFolder', '').trim();
            if (last) base = path.dirname(last);
            else if (this.vmixRecordFolder) base = this.vmixRecordFolder;
        }
        this.status.saveFolder = base
            ? path.join(base, eventFolderName(effectiveEvent))
            : null;

        this.emitter.emit('status', this.getStatus());
    }

    // Current status snapshot (for IPC getState)
    public getStatus(): AutoAVStatus {
        return {
            ...this.status,
            vmix: { ...this.status.vmix },
            currentEvent: this.status.currentEvent
                ? { ...this.status.currentEvent }
                : null,
        };
    }

    // Poll vMix so the tab can show whether it's reachable / recording
    private startVmixPoll() {
        this.stopVmixPoll();
        this.vmixPollTimer = setInterval(() => this.pollVmix(), 5000);
        this.pollVmix();
    }

    private stopVmixPoll() {
        if (this.vmixPollTimer) {
            clearInterval(this.vmixPollTimer);
            this.vmixPollTimer = null;
        }
    }

    // Poll FMS for its event so a new event renames recordings without anyone
    // touching the settings dialog.
    private startFmsEventPoll() {
        this.stopFmsEventPoll();
        this.fmsEventTimer = setInterval(() => this.checkFmsEvent(), 30000);
        this.checkFmsEvent();
    }

    private stopFmsEventPoll() {
        if (this.fmsEventTimer) {
            clearInterval(this.fmsEventTimer);
            this.fmsEventTimer = null;
        }
    }

    // When FMS reports a different event code than the one the name was last
    // filled from, replace the event name with FMS's. Same code = leave the
    // name alone, so a volunteer's hand edit survives until the next event.
    private async checkFmsEvent() {
        const info = await FmsApi.Instance.getEventInfo();
        // With FMS and the FTC scorekeeper both up, each reports its own
        // event; only the active program's counts, or the two would take
        // turns being "new".
        if (!info || this.isFtc()) return;
        this.noteEvent('frc', info.eventCode, info.eventName || info.eventCode);
    }

    // The one place a new event is detected. Both field systems report their
    // event here (FMS through checkFmsEvent, the FTC scorekeeper through
    // onFtcStatus). A different program:code than last time is a new event:
    // the event name is refilled from the field system, per-event choices go
    // back to their defaults (the FRC audience display to the official FMS
    // display), and eventChanged tells everything else. The same event again
    // changes nothing, so a volunteer's hand edits survive until the next one.
    private noteEvent(program: Program, code: string, name: string) {
        const store = getStore();
        const key = `${program}:${code}`;
        if (key === store.get('autoAv.lastEventKey', '')) return;
        const previous = store.get('autoAv.lastEventKey', '');
        store.set('autoAv.lastEventKey', key);
        store.set('autoAv.eventNameOverride', name);
        store.set('frcAudienceDisplay', 'fms');
        this.log(`Event is now ${key} (was ${previous || 'none'}): "${name}"`);
        this.emitStatus();
        this.emitMatches();
        this.emitter.emit('eventChanged', { program, code, name });
    }

    // Read vMix's configured recording folder from its .NET user.config (the
    // Web API only reports it while actively recording). Safe heuristic: a
    // setting whose NAME contains "record" whose value is an existing directory.
    // Returns null rather than a wrong guess.
    private static readVmixConfigRecordFolder(): string | null {
        try {
            const base = path.join(process.env.LOCALAPPDATA || '', 'vMix');
            const files = glob
                .sync(path.join(base, 'vMix*', '*', 'user.config'))
                .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
                .sort((a, b) => b.m - a.m);
            let found: string | null = null;
            files.forEach(({ f }) => {
                if (found !== null) return;
                const xml = fs.readFileSync(f, 'utf8');
                const re =
                    /<setting name="[^"]*record[^"]*"[^>]*>\s*<value>([A-Za-z]:\\[^<]+?)<\/value>/gi;
                const hit = [...xml.matchAll(re)]
                    .map((m) => m[1].trim())
                    .find((dir) => fs.existsSync(dir));
                if (hit) found = hit;
            });
            return found;
        } catch {
            // best effort
        }
        return null;
    }

    private async pollVmix() {
        let reachable = false;
        let recording = false;
        let recordFolder: string | null = this.vmixRecordFolder;
        try {
            const parsed = await VmixService.Instance.GetBase();
            reachable = !!parsed?.vmix;
            recording = parsed?.vmix?.recording?.['#text'] === 'True';
            // vMix reports the record destination as recording.filename1, but
            // only while actively recording. When idle, fall back to reading its
            // config file.
            const file =
                parsed?.vmix?.recording?.filename1 ??
                parsed?.vmix?.recording?.filename;
            if (typeof file === 'string' && file.trim()) {
                const i = Math.max(
                    file.lastIndexOf('\\'),
                    file.lastIndexOf('/')
                );
                recordFolder = i > 0 ? file.slice(0, i) : file;
            } else if (!recordFolder) {
                recordFolder = AutoAV.readVmixConfigRecordFolder();
            }
        } catch {
            reachable = false;
            recording = false;
        }
        const folderChanged = recordFolder !== this.vmixRecordFolder;
        if (folderChanged) this.vmixRecordFolder = recordFolder;
        if (
            this.status.vmix.reachable !== reachable ||
            this.status.vmix.recording !== recording ||
            folderChanged
        ) {
            this.status.vmix = { reachable, recording };
            this.emitStatus();
            // A changed record folder means a different event: refresh history.
            if (folderChanged) this.emitMatches();
        }
    }

    // Best-effort fetch of teams + card status for a finished match, patched
    // onto the record after it's been renamed. Never throws into the stop path.
    // Returns the card status: true (carded), false (clean), or undefined when
    // it couldn't be determined, so the caller can honour the no-cut card rule.
    private async captureMetadata(
        folder: string,
        recordId: string,
        matchData: FMSMatchStatus
    ): Promise<boolean | undefined> {
        try {
            const results = await FmsApi.Instance.getMatchResults(
                matchData.Level,
                matchData.MatchNumber
            );
            if (!results) return undefined;
            const record = updateMatch(folder, recordId, {
                teams: results.teams,
                hasCard: results.hasCard,
                score: results.score,
            });
            if (record) {
                this.emitter.emit('match', record);
                this.logRecording(
                    `Captured metadata for ${matchData.Level} Match ${
                        matchData.MatchNumber
                    }${results.hasCard ? ' (card issued)' : ''}`,
                    undefined,
                    EquipmentLogType.Debug
                );
            }
            return results.hasCard;
        } catch (err) {
            this.logRecording(
                'Failed to capture match metadata',
                err as object,
                EquipmentLogType.Warn
            );
            return undefined;
        }
    }

    // Cut the dead time out of a recorded match in place: the original video is
    // moved into an "Originals" subfolder and the trimmed, upload-ready cut takes
    // its spot in the base event folder (so the base folder holds every match's
    // final video, cut and uncut alike). Queued so a burst of matches encodes one
    // at a time and never starves vMix/streaming of CPU. Best-effort: a failure
    // restores the original and only marks the record. Refuses carded matches so
    // their explanation (which lives in the dead time) is preserved. Used by both
    // the auto-cut path and the manual Cut button.
    public queueCut(folder: string, recordId: string): void {
        const rec = getMatch(folder, recordId);
        if (!rec) return;
        if (rec.ftc) {
            this.ftcRecorder.remake(folder, recordId);
            return;
        }
        if (!rec.filePath) return;
        if (rec.hasCard) {
            this.logRecording(
                `Not cutting ${rec.fileName} (card issued, keeping explanation)`,
                undefined,
                EquipmentLogType.Debug
            );
            return;
        }
        const state = rec.processing?.state;
        if (state === 'queued' || state === 'processing') return;

        const mainPath = rec.filePath;
        const originalsDir = path.join(folder, 'Originals');
        // A file of the same name already in Originals belongs to another
        // match (an earlier event or test with the same name): never cut
        // from it or replace it.
        let originalPath = path.join(originalsDir, path.basename(mainPath));
        const { name, ext } = path.parse(mainPath);
        for (let n = 2; fs.existsSync(originalPath); n += 1) {
            originalPath = path.join(originalsDir, `${name} (${n})${ext}`);
        }
        // ffmpeg writes here; the cut replaces mainPath only once complete.
        const cutPath = path.join(folder, `${name}.cutting${ext}`);

        const queued = updateMatch(folder, recordId, {
            processing: { state: 'queued' },
        });
        if (queued) this.emitter.emit('match', queued);

        enqueueCut(async () => {
            let moved = false;
            try {
                if (!fs.existsSync(originalsDir)) {
                    fs.mkdirSync(originalsDir, { recursive: true });
                }
                const started = updateMatch(folder, recordId, {
                    processing: { state: 'processing' },
                });
                if (started) this.emitter.emit('match', started);
                this.logRecording(`Cutting ${path.basename(mainPath)}`);

                // Move the original aside, cut it into a temp file, then put
                // the cut where the original was.
                fs.renameSync(mainPath, originalPath);
                moved = true;
                await cutMatchVideo(originalPath, cutPath);
                fs.renameSync(cutPath, mainPath);

                const done = updateMatch(folder, recordId, {
                    processing: { state: 'done', outputPath: mainPath },
                });
                if (done) this.emitter.emit('match', done);
                queueLoudness(folder, recordId, mainPath, (r) =>
                    this.emitter.emit('match', r)
                );
                this.logRecording(
                    `Cut ${path.basename(
                        mainPath
                    )}; original kept in Originals`,
                    undefined,
                    EquipmentLogType.Debug
                );
            } catch (err: any) {
                // Drop a partial cut and put the original back, so the base
                // folder (which the uploader reads) holds the full recording.
                try {
                    fs.rmSync(cutPath, { force: true });
                    if (
                        moved &&
                        !fs.existsSync(mainPath) &&
                        fs.existsSync(originalPath)
                    ) {
                        fs.renameSync(originalPath, mainPath);
                    }
                } catch {
                    // best effort
                }
                const failed = updateMatch(folder, recordId, {
                    processing: {
                        state: 'error',
                        error: String(err?.message ?? err),
                    },
                });
                if (failed) this.emitter.emit('match', failed);
                this.logRecording(
                    'Failed to cut recording',
                    err as object,
                    EquipmentLogType.Warn
                );
            }
        });
    }

    // Emit the recorded-match list for the folder the app is currently pointed
    // at, so the tab's history reflects the current event folder.
    // The recorded matches in the event folder, plus the match being recorded
    // now: its record only reaches the folder's manifest when the recording
    // stops, so a list read from disk alone drops it mid-match.
    public matches(): MatchRecord[] {
        const list = listMatches(this.status.saveFolder);
        const live = this.weAreRecording ? this.currentRecordObj : null;
        if (live && !list.some((r) => r.id === live.id)) list.unshift(live);
        return list;
    }

    public emitMatches(): void {
        this.emitter.emit('matches', this.matches());
    }

    public static get Instance(): AutoAV {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }

    // eslint-disable-next-line no-unused-vars
    public on(event: AutoAVEvent, listener: (arg: any) => void) {
        this.emitter.on(event, listener);
    }

    // eslint-disable-next-line no-unused-vars
    public off(event: AutoAVEvent, listener: (arg: any) => void) {
        this.emitter.off(event, listener);
    }

    // eslint-disable-next-line no-unused-vars
    public once(event: AutoAVEvent, listener: (arg: any) => void) {
        this.emitter.once(event, listener);
    }
}
