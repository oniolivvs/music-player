# 🎵 Music Player

A **native, local-first Windows music player** (Tauri + Rust audio engine).

Supported platform: **Windows 10/11 only**. Linux, Android and macOS builds are
not produced or supported.

## Install

Prebuilt Windows NSIS installers are produced by the release workflow.

**PowerShell:**

```powershell
irm https://raw.githubusercontent.com/oniolivvs/music-player/main/install.ps1 | iex
```

Or download and run the `*-setup.exe` from the release page. Once the manifests
in [`winget/`](winget/) are published: `winget install oniolivvs.MusicPlayer`.

The built-in YouTube engine works without extra binaries. `yt-dlp` is an
optional booster and can be installed from the app settings.

## Build from source

Install the [Tauri v2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/),
then run `npm install` and `npm run build`.

## What it does

- Plays your **local audio files** (mp3, flac, wav, ogg/opus, m4a, aac) through a
  real native audio engine (Rust `rodio` → system audio device), not a WebView `<audio>`.
- Manages **playlists** (create / edit / reorder / import / export), mixing local
  files and online tracks freely.
- **YouTube integration via yt-dlp** (same approach as the owner's
  `play_yt_audio.sh` desktop script — personal use):
  - **Search**: type in the search bar and press Enter to search YouTube; results
    show thumbnail + channel and can be played or added to playlists.
  - **Playlist import**: paste a playlist URL (sidebar → *Import from URL…*),
    tick the tracks you want, import into a new or existing playlist.
  - **Instant streaming**: tracks stream over HTTP range requests straight into
    the rodio engine (no full download first); resolved stream URLs are cached
    and the next queue entry is pre-resolved + pre-queued for gapless playback.
  - **Local downloads**: right-click → *⬇ Download locally* (or tick *Save
    locally* when importing a playlist) saves tracks as mp3 via yt-dlp into the
    Settings → Downloads folder (default `~/Music/MusicPlayer`), auto-adds that
    folder as a source and swaps playlist entries to the local files.
- **Windows media integration (SMTC)**: the volume flyout, media keys and
  Bluetooth/USB headset controls see the current track and can control playback.
- Optionally **syncs YouTube Music library metadata** (playlists, likes) read-only via
  Google OAuth2 — as organizational reference only. See `docs/oauth-sync.md`.

> ⚠️ **Note (2026-07)**: an earlier revision of this README declared a hard
> "no yt-dlp / no stream extraction" compliance boundary. That decision was
> reversed by the project owner, who explicitly requested yt-dlp-based search,
> import and streaming modeled on their own download script. Be aware that
> stream extraction sits outside YouTube's Terms of Service; this stays a
> personal-use tool. The native engine needs no external executable; `yt-dlp`
> remains an optional fallback.

## Architecture

```
music-player/
├── src/                    Frontend (static, no bundler — uses window.__TAURI__)
│   ├── index.html          Layout: library · playlists · player bar
│   ├── main.js             IPC to the Rust core + UI wiring (browser-mock fallback)
│   ├── playlists.js        Playlist CRUD helpers
│   ├── settings.js         Settings defaults, themes and accent colors
│   ├── store.js            Tauri IPC wrapper with localStorage fallback
│   └── style.css
├── src-tauri/              Native core (Rust)
│   ├── src/
│   │   ├── main.rs         Tauri app, command handlers, self-update + version switching
│   │   ├── audio.rs        Audio engine: dedicated thread + mpsc + rodio Sink (epoch-tagged)
│   │   ├── stream.rs       HTTP range-request Read+Seek source (instant streaming)
│   │   ├── youtube.rs      yt-dlp bridge: search, playlists, URL resolve+cache, downloads
│   │   ├── mpris.rs        Windows SMTC media controls (souvlaki)
│   │   ├── rpc.rs          Discord Rich Presence (IPC, auto-reconnect)
│   │   ├── library.rs      Filesystem scan + tag reading (lofty)
│   │   ├── store.rs        Generic JSON key-value persistence (atomic writes)
│   │   └── importer.rs     Spotify playlist/album import (public embed scraping)
│   ├── Cargo.toml
│   ├── build.rs
│   └── tauri.conf.json
└── docs/
    └── oauth-sync.md       Google OAuth2 read-only metadata sync design (roadmap #4)
```

Module boundaries (each folder = one responsibility):
- **audio** — decode + output only. No knowledge of the library or UI.
- **library** — filesystem + tags only. Returns plain `Track` structs.
- **youtube** — yt-dlp orchestration: search, resolve, download, cache.
- **stream** — HTTP range-request adapter for remote audio.
- **frontend** — rendering + user intent. Talks to the core via `invoke(...)`.
- **sync** (docs only, not yet wired) — read-only metadata bridge, isolated from playback.

## Prerequisites

- Windows 10/11 with WebView2
- **Rust** stable with the MSVC toolchain — <https://rustup.rs>
- **Node.js** ≥ 18
- Microsoft C++ Build Tools, as listed in the
  [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)

## Build & run

```powershell
npm install
npm test
npm run dev
npm run build
```

## Roadmap (opt-in, in order)

1. ~~Native folder picker (`tauri-plugin-dialog`)~~ ✅ done.
2. ~~Playlist persistence to app-data JSON~~ ✅ done (`playlists.json` in the app data
   dir, written atomically by the Rust backend; localStorage only as browser fallback).
3. ~~Gapless playback + ReplayGain loudness~~ ✅ done (engine pre-queues the next
   track into the same sink; per-track `amplify()` from ReplayGain tags; 20 ms
   anti-click fade-in). True crossfade is out — it needs a mixing layer rodio's
   sequential `Sink` doesn't provide.
4. Google OAuth2 read-only metadata sync (`docs/oauth-sync.md`) — needs a
   user-provided Google Cloud Client ID.
5. Optional official YouTube IFrame provider (separate, opt-in).

## Versioning / GitHub

Standard workflow for a desktop app (releases + CI). Create the remote with:

```bash
gh repo create music-player --source=. --remote=origin --push
```
