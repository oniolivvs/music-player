# 🎵 Music Player

A **native, local-first** desktop music player (Tauri + Rust audio engine).

## Install

Prebuilt bundles are produced by the release workflow (push a `v*` tag → GitHub
Release with Linux `.AppImage`/`.deb`/`.rpm` and a Windows `-setup.exe`).

**Linux (any distro), one line:**

```sh
curl -fsSL https://raw.githubusercontent.com/oniolivvs/music-player/main/install.sh | bash
```

It picks the `.deb`/`.rpm` for your package manager, or falls back to the
portable AppImage. Pin a version with `MP_VERSION=v0.9.2`.

**Windows (PowerShell), one line:**

```powershell
irm https://raw.githubusercontent.com/oniolivvs/music-player/main/install.ps1 | iex
```

Or download and run the `*-setup.exe` from the release page. Once the manifests
in [`winget/`](winget/) are published: `winget install oniolivvs.MusicPlayer`.

> `yt-dlp` and `ffmpeg` are fetched automatically on first use (Linux). On
> Windows, install them and put them on `PATH`.

## Build from source

Needs the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
(Rust + WebKitGTK 4.1 on Linux). Then `cd src-tauri && cargo build --release`, or
`cargo tauri build` for the packaged bundles.

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
- **Desktop media integration (MPRIS)**: the player registers as
  `org.mpris.MediaPlayer2.musicplayer` on D-Bus (souvlaki/zbus), so KDE/GNOME
  media widgets, `playerctl` and media keys see the current track (title,
  artist, artwork, position) and can control play/pause/next/seek.
- Optionally **syncs YouTube Music library metadata** (playlists, likes) read-only via
  Google OAuth2 — as organizational reference only. See `docs/oauth-sync.md`.

> ⚠️ **Note (2026-07)**: an earlier revision of this README declared a hard
> "no yt-dlp / no stream extraction" compliance boundary. That decision was
> reversed by the project owner, who explicitly requested yt-dlp-based search,
> import and streaming modeled on their own download script. Be aware that
> stream extraction sits outside YouTube's Terms of Service; this stays a
> personal-use tool. Requires `yt-dlp` on the machine (PATH, `~/Desktop/bin`,
> `~/.local/bin`, or linuxbrew).

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
│   │   ├── mpris.rs        MPRIS D-Bus media controls (souvlaki) → desktop widgets
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

- **Rust** (stable) + Cargo — <https://rustup.rs>
- **Node.js** ≥ 18 (only for the Tauri CLI)
- Tauri v2 system deps: `webkit2gtk4.1-devel`, `alsa-lib-devel` (audio), `gtk3`,
  `librsvg2-devel`, `libappindicator-gtk3-devel`, a C toolchain — see
  <https://tauri.app/start/prerequisites/>.

### On immutable/atomic distros (Bazzite, Silverblue, Kinoite…)

`dnf` is disabled on the host by design. **Do all dev inside a Distrobox container**
(mutable, rootless, no host password, shares your `$HOME` and display):

```bash
distrobox create --name dev --image registry.fedoraproject.org/fedora:41 --yes
distrobox enter dev -- sudo dnf install -y \
  webkit2gtk4.1-devel openssl-devel curl wget file librsvg2-devel \
  libappindicator-gtk3-devel alsa-lib-devel gcc gcc-c++ nodejs
distrobox enter dev -- sudo dnf group install -y "c-development"
```

Rust lives in `~/.cargo` (shared home), so it's available inside the container too.

## Build & run

```bash
npm install          # installs @tauri-apps/cli (host is fine)

# Inside the dev container (or directly if you have the toolchain on the host):
cd music-player/src-tauri && cargo build

# Launch the native window (embeds the static frontend — no dev server needed):
./src-tauri/target/debug/music-player
```

For hot-reload development instead of a one-off binary:
`npm run dev` (or inside the container: `distrobox enter dev -- bash -lc 'source ~/.cargo/env; cd ~/music-player && npm run dev'`).

> ✅ **Verified** (2026-07): builds clean inside a Fedora 41 container (rodio 0.21 /
> lofty 0.21 / tauri 2.11), `cargo build` → exit 0. Streaming pipeline verified
> headlessly: a real YouTube m4a decoded over HTTP ranges (`cargo run --example
> stream_test -- <url>`) and local mp3 decode + seek (`--example local_test`).
> rodio was bumped 0.19 → 0.21: the isomp4 demuxer needs `with_byte_len()` to
> probe YouTube's moov-after-mdat files, which 0.19 couldn't provide.

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
