# FIM AV software map

Every program that runs on or around an FIM AV cart, and what talks to what. Drawn 2026-10-04
from the code of each repo (fimav-assistant `feat/auto-av-tab`, audience-display v26.7.1,
live-captions, youtube-tba-upload v0.1.8, ftc-vmix-autoav, fake-fms, decompiled FMS 2026).

## System diagram

Solid arrows are built and in use. Dashed arrows are FTC pieces that exist but are not part
of FIM-AV Assistant today.

```mermaid
flowchart LR
    classDef app fill:#1f3a5f,stroke:#5b9bd5,color:#fff
    classDef exe fill:#2d4a2d,stroke:#7cbf7c,color:#fff
    classDef third fill:#4a3b1f,stroke:#d5a85b,color:#fff
    classDef field fill:#4a1f1f,stroke:#d55b5b,color:#fff
    classDef cloud fill:#333,stroke:#aaa,color:#fff
    classDef ftc fill:#3b2d4a,stroke:#b07cd5,color:#fff,stroke-dasharray:4 3

    subgraph CART["AV cart (Windows)"]
        direction TB
        FIMAV["FIM-AV Assistant<br/>Electron app<br/>status API :7780"]:::app
        subgraph INPROC["in-process"]
            AUTOAV["AutoAV<br/>records + files matches<br/>fimav-matches.json"]:::app
            HWPING["HW ping<br/>switch, PTZ, mixer, internet"]:::app
            BFMOD["Bitfocus module<br/>button editor + triggers"]:::app
        end
        subgraph SPAWNED["spawned exes (downloaded from GitHub releases)"]
            LC["live-captions.exe<br/>Node via pkg · :3000"]:::exe
            YTU["youtube-tba-upload.exe<br/>Go · :8807"]:::exe
            CAD["audience-display.exe<br/>Bun · :3001"]:::exe
        end
        VMIX["vMix<br/>HTTP API :8088<br/>inputs: FMS, Live Captions,<br/>Alliance Cam, PTZ, NDI"]:::third
        COMP["Bitfocus Companion<br/>:8000 HTTP + tRPC ws"]:::third
        FFMPEG["vMix's ffmpeg6.exe"]:::third
        DECK["Stream Deck"]:::third
    end

    subgraph FIELD["Field network 10.0.100.0/24"]
        FMS["FRC FMS 10.0.100.5<br/>SignalR hubs + REST /api/v1.0"]:::field
        FMSAD["FMS audience display page<br/>BitFocusService"]:::field
        FAKE["fake-fms (dev stand-in)"]:::field
    end

    subgraph FTCNET["FTC event network"]
        SK["FTC Live scorekeeper<br/>ws /stream/display/command<br/>REST /api/v1"]:::ftc
        FTCAV["ftc-vmix-autoav.exe<br/>Node via nexe, run by hand"]:::ftc
    end

    subgraph AVLAN["AV LAN 192.168.25.0/24"]
        SW["switch"]:::third
        PTZ["PTZ 1 / PTZ 2"]:::third
        XAIR["X-Air mixer"]:::third
    end

    subgraph CLOUD["Internet"]
        ADMIN["fim-admin AssistantHub<br/>SignalR"]:::cloud
        GH["GitHub releases"]:::cloud
        YT["YouTube<br/>Studio upload · caption ingest"]:::cloud
        TBA["The Blue Alliance<br/>trusted API"]:::cloud
        GSTT["Google Speech-to-Text"]:::cloud
        LCCLOUD["live-captions cloud-server"]:::cloud
        NC["Nextcloud WebDAV<br/>FMS log archive"]:::cloud
    end

    FIMAV -->|"start / stop / update"| SPAWNED
    AUTOAV -->|"infrastructureHub<br/>GetEventInfo, results"| FMS
    AUTOAV -->|"record start/stop,<br/>inputs, stream keys"| VMIX
    AUTOAV -->|"cut dead time"| FFMPEG
    AUTOAV <-->|"shared manifest<br/>+ .lock"| YTU
    HWPING -.->|"ICMP"| AVLAN
    BFMOD -->|"export + tRPC ws"| COMP
    BFMOD -->|"GetAudienceDisplayConfigs<br/>SaveAudienceDisplayConfig"| FMS
    BFMOD -->|"/api/companion/config"| CAD
    FIMAV -->|"AppInfo, logs, alerts, events"| ADMIN
    FIMAV -->|"youtubeCaptions.setUrl"| LC

    VMIX -->|"browser input :3000"| LC
    VMIX -->|"browser input :3001/display"| CAD
    VMIX -->|"browser input (in-season)"| FMSAD
    VMIX -->|"NDI / SDI"| PTZ
    DECK --> COMP
    COMP -->|"vMix module"| VMIX
    COMP -->|"OSC"| XAIR

    CAD -->|"3 SignalR hubs + REST"| FMS
    CAD -->|"button press + custom variables"| COMP
    CAD -->|"config.set display.position"| LC
    CAD -->|"ensure FMS input,<br/>Alliance Cam composite"| VMIX
    CAD -->|"gzip NDJSON"| NC
    FMSAD -->|"button press"| COMP
    FMSAD --> FMS
    FAKE -.->|"same wire as FMS"| FMS

    LC -->|"audio → text"| GSTT
    LC -->|"captions POST"| YT
    LC -->|"ensure Live Captions input"| VMIX
    LC -.->|"optional fleet config"| LCCLOUD
    YTU -->|"headless Chrome → Studio"| YT
    YTU -->|"match video links"| TBA
    YTU -->|"scores"| FMS

    GH -->|"live-captions, uploader,<br/>audience-display, FIM-AV itself"| FIMAV

    FTCAV -.->|"SHOW_PREVIEW / SHOW_MATCH"| SK
    FTCAV -.->|"QuickPlay input per field"| VMIX
```

## Components

| Component | Repo | Runtime | Ships as | Listens | Talks to |
|---|---|---|---|---|---|
| FIM-AV Assistant | FIRSTinMI/fimav-assistant | Electron 23 | NSIS installer, electron-updater from GitHub | 7780 (status API) | FMS, vMix, Companion, fim-admin, the three exes below |
| AutoAV (in FIM-AV) | same | in-process | | | FMS infrastructureHub + REST, vMix API, ffmpeg, `fimav-matches.json` |
| Bitfocus module (in FIM-AV) | same | in-process | | | Companion `/int/export/full` + `ws /trpc`, FMS audience config, custom AD config |
| live-captions | FIRSTinMI/live-captions | Node 22 via pkg | single exe, auto-update from GitHub | 3000 (overlay `/`, `settings.html`, tRPC http+ws) | Google STT, YouTube caption ingest, vMix (adds "Live Captions" input, overlay 8), optional cloud-server |
| youtube-tba-upload | Filip-Kin/youtube-tba-upload | Go | single exe, pulled by FIM-AV | 8807 | YouTube Studio (bundled Chrome), TBA trusted API, FMS results, shared manifest |
| audience-display | Filip-Kin/audience-display | Bun compiled | single exe with embedded UI, pulled by FIM-AV (own auto-update off) | 3001 (`/` operator, `/display`, `/bitfocus`, `/api/*`, `/ws`) | FMS 3 hubs + REST, vMix, Companion, live-captions position, Nextcloud log sync |
| FMS audience display page | FIRST (decompiled) | FMS web app | part of FMS | | Companion presses per BitfocusStateTypes; config stored by FMS |
| FRC FMS | FIRST | .NET | field PC | 80 (SignalR + REST) | |
| fake-fms | Filip-Kin/fake-fms | Bun | Docker at 10.0.100.5 (home) | 80, 3010 control | stands in for FMS |
| Bitfocus Companion | Bitfocus | Electron | installed app | 8000 | vMix, X-Air, Stream Deck |
| vMix | StudioCoast | native | installed app | 8088 API, 8099 TCP | cameras, NDI, streams |
| ftc-vmix-autoav | FIRSTinMI/ftc-vmix-autoav | Node 14 via nexe | single exe, run by hand in a console | none | FTC Live scorekeeper ws, vMix QuickPlay |
| FTC Live scorekeeper | FIRST | Java | scorekeeping PC | 80 (`/stream/display/command?code=`, `/api/v1`) | |

## Where the season is decided

FIM-AV asks FMS `GetEventInfo` every 30 s. `isOfficial` true = in-season (short file names, FMS
audience display, no uploader, no cutting). `isOfficial` false = off-season (readable file names,
custom audience display, uploader, cutting, Upload and Offseason AD tabs). No FMS answer = the
stored fallback. The Bitfocus tab's trigger source (FMS display vs custom display) is a separate
setting.

## FTC today

Nothing in FIM-AV knows FTC. The only FTC AV tool is `ftc-vmix-autoav`: an operator runs the exe
in a console, types the scorekeeper IP, event code and vMix input numbers, and it switches vMix
inputs on the scorekeeper's `SHOW_PREVIEW` / `SHOW_MATCH` websocket events. The FTC scorekeeper is
addressed by a typed `ip:port` (no fixed address like 10.0.100.5), its live stream carries only
field and timestamp (no auto/teleop/endgame phases), and match state is `UNPLAYED` / `PLAYED`.
FiM's admin backend (`FiMAdminApi`) already reads FTC results from the cloud FTC Events API, so
event metadata for FTC exists on the admin side.

## Runtimes shipped to a cart

| Runtime | Carried by | Approx. size |
|---|---|---|
| Chromium + Node (Electron) | FIM-AV Assistant, Companion | 2 copies |
| Node 22 (pkg) | live-captions | 1 |
| Bun | audience-display | 1 |
| Node 14 (nexe) | ftc-vmix-autoav | 1 |
| none | youtube-tba-upload (Go), vMix, ffmpeg (vMix's own) | |

Each program also runs on its own outside FIM, which is why each carries its runtime.

## Open directions (not built)

- **FTC in FIM-AV:** detect the event type (FMS answers at 10.0.100.5 → FRC; a scorekeeper
  answers `/stream/display/command` → FTC), then show FTC tabs and fold `ftc-vmix-autoav`'s
  switching into AutoAV instead of a hand-run console.
- **One runtime:** stop shipping Node/Bun inside every exe when FIM-AV runs them; keep the
  standalone exes for people outside FIM.
- **Native tabs:** replace the live-captions and audience-display iframes with FIM-AV's own UI
  over their existing APIs (live-captions tRPC; audience-display `/api/*` + `/ws`).
