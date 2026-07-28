// App settings: an in-memory object persisted via the generic store ("settings").
// loadSettings() is awaited once at startup; setSetting() persists immediately.

import { storeLoad, storeSave } from "./store.js";

export const THEMES = {
  dark:     { "--bg-0": "#0b0b0f", "--bg-1": "#121218", "--bg-2": "#17171f", "--bg-3": "#20202b", "--bg-4": "#2a2a38", "--tx-1": "#f4f5f8", "--tx-2": "#a6a9b8", "--tx-3": "#6d7080" },
  midnight: { "--bg-0": "#060b18", "--bg-1": "#0b1224", "--bg-2": "#101a30", "--bg-3": "#16233f", "--bg-4": "#1e2f52", "--tx-1": "#eef2fb", "--tx-2": "#9fb0d0", "--tx-3": "#64748b" },
  black:    { "--bg-0": "#000000", "--bg-1": "#050506", "--bg-2": "#0a0a0c", "--bg-3": "#141418", "--bg-4": "#1f1f26", "--tx-1": "#f5f5f5", "--tx-2": "#a3a3ad", "--tx-3": "#66686f" },
  plum:     { "--bg-0": "#120a14", "--bg-1": "#1a0f1e", "--bg-2": "#221429", "--bg-3": "#2e1c38", "--bg-4": "#3b2549", "--tx-1": "#f7f2fa", "--tx-2": "#c0aed0", "--tx-3": "#7d6b8f" },
  forest:   { "--bg-0": "#08110c", "--bg-1": "#0d1a12", "--bg-2": "#122218", "--bg-3": "#1a2f21", "--bg-4": "#243e2d", "--tx-1": "#f0f7f2", "--tx-2": "#a3c2ad", "--tx-3": "#5f7a68" },
};

export const ACCENTS = {
  violet: ["#8B5CF6", "#A78BFA"],
  green:  ["#1DB954", "#1ED760"],
  blue:   ["#3B82F6", "#60A5FA"],
  pink:   ["#EC4899", "#F472B6"],
  orange: ["#F59E0B", "#FBBF24"],
  red:    ["#EF4444", "#F87171"],
  teal:   ["#14B8A6", "#2DD4BF"],
};

const DEFAULTS = {
  accent: "violet",
  showArt: true,
  compactRows: false,
  animations: true,
  smoothScroll: true,    // eased scrolling on lists/panels (Performance group)
  smoothStrength: 3,     // smooth-scroll intensity 1 (subtle) … 5 (long glide)
  defaultVolume: 80,
  normalizeDefault: true,
  shuffleDefault: false,
  repeatDefault: "off", // off | all | one — the repeat button persists here
  notifyOnChange: true,
  rpcEnabled: false,
  rpcClientId: "",
  preloadNext: true,     // gapless: pre-queue the next track
  resumePlayback: true,  // on launch, restore the last track (paused) at its saved position
  resumeDownloads: true, // on launch, re-queue downloads that hadn't finished (yt-dlp continues .part files)
  historyLimit: 50,      // listening history size (0 = don't keep … up to 1000)
  rpcDelay: 0,           // Discord RPC: seconds to wait before showing a new track (debounces fast skips)
  rpcPauseClear: 0,      // Discord RPC: seconds after pausing before the presence is removed (0 = immediately)
  compactTopbar: false,  // slimmer top bar
  topbarPad: 13,         // top bar vertical padding (px) — customizable height
  sliderImage: "",       // custom image for the slider thumb (the "pink dot"); empty = accent color
  thumbSize: 12,         // slider thumb diameter (px)
  downloadDir: "",       // empty = ~/Music/MusicPlayer (resolved by the backend)
  preferLocal: true,     // play the local file when an online track is downloaded
  autoSaveImports: false, // pre-tick "Save locally" in the import dialog
  searchLimit: 20,       // YouTube search result count
  ytdlpPath: "",         // explicit yt-dlp binary; empty = auto-detect
  cookiesBrowser: "",    // --cookies-from-browser value; empty = off
  startOnBoot: false,    // launch the app automatically at login (OS autostart; source of truth is the autostart plugin)
  setupDone: false,      // first-run wizard completed
  updateMode: "ask",     // ask (propose) | auto (build silently) | off
  followInterval: "6h",  // follow checks: launch (startup only) | 1h | 6h | 24h
  sortMode: "default",   // default | title | title-desc | artist | album | dur | dur-desc
  theme: "dark",         // key of THEMES, or "custom"
  customBg: "#0b0b0f",   // custom theme: window background
  customPanel: "#121218",// custom theme: panel base (shades derived)
  customText: "#f4f5f8", // custom theme: text (secondary shades derived)
  radius: 12,            // corner radius (px) of panels/rows
  uiScale: 100,          // UI zoom %
  bgTextMode: "auto",    // text on wallpaper: auto (detect brightness) | light | dark
  // Interface: hide/arrange elements
  uiSources: true,       // show the Sources section
  uiSrcButtons: true,    // show "Add folder…" / "Enter a path manually"
  uiPlaylists: true,     // show the Playlists section
  uiImportBtn: true,     // show "Import from URL…"
  uiSortSel: true,       // show the sort selector
  collSources: false,    // Sources section collapsed
  collPlaylists: false,  // Playlists section collapsed
  npDocked: false,       // Up-next panel docked as a side column
  uiNpOpen: false,       // Up-next panel open (restored at launch)
  sideW: 268,            // sidebar width (px) — drag the handle on its right edge
  npW: 330,              // Now-playing panel width (px) — drag its left edge
  ytView: "grid",        // YouTube results on desktop: grid (mini-YouTube cards) | list
  ytViewTouch: "list",   // YouTube results on phones/touch: rows read better + 40px covers
  ytIncludeVideos: true, // search bar returns YouTube videos
  ytIncludePlaylists: true, // search bar also returns YouTube playlists
  playlistPreviewCount: 25, // tracks shown in the playlist detail window (1..200)
  downloadQuality: "best",  // mp3/m4a bitrate cap: best | 320 | 256 | 192 | 128
  dlConcurrency: 3,      // simultaneous invoke("yt_download") calls the queue pump runs (1-4)
  storageCapMb: 0,       // max MB of audio a source folder may hold (0 = unlimited)
  showBlocked: false,    // reveal blocked tracks (greyed) instead of hiding them
  gdriveClientId: "",    // user's Google OAuth Client ID (Desktop app)
  gdriveClientSecret: "",// user's Google OAuth Client secret (Desktop app)
  gdriveTokens: null,    // { refresh_token, access_token, expires_at, email }
  syncAuto: true,        // auto push/pull on changes + launch
  syncAt: 0,             // last successful sync (unix ms)
  bgImage: "",           // custom background: URL or local file path
  bgBlur: 18,            // px of blur on the background image
  bgDim: 45,             // % darkening of the background image
  panelAlpha: 85,        // % opacity of panels when a background is set
};

let _s = { ...DEFAULTS };

export function resetSettings() {
  _s = { ...DEFAULTS };
  storeSave("settings", JSON.stringify(_s));
  return _s;
}

export async function loadSettings() {
  const raw = await storeLoad("settings");
  if (raw) { try { _s = { ...DEFAULTS, ...JSON.parse(raw) }; } catch {} }
  return _s;
}

export function getSettings() { return _s; }

let _saveTimer = null;
export function setSetting(key, value) {
  if (_s[key] === value) return;
  _s[key] = value;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    storeSave("settings", JSON.stringify(_s));
  }, 100);
}
