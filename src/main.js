// Frontend controller. Native Rust core over Tauri IPC: gapless engine, wall-clock
// progress, persisted library + sources + playlists + settings, Spotify-style
// selection + context menu, desktop notifications + optional Discord Rich Presence.

import * as PL from "./playlists.js";
import * as SETTINGS from "./settings.js";
import { storeLoad, storeSave } from "./store.js";

// Signals to the index.html OTA bootstrap that this frontend loaded — its
// watchdog rolls back to the embedded build if this never runs (broken OTA).
window.__MP_BOOTED__ = true;

const T = window.__TAURI__;
const IS_NATIVE = !!(T && T.core && typeof T.core.invoke === "function");
const IS_ANDROID = IS_NATIVE && /android/i.test(navigator.userAgent);

// Must match ota.json "version" — bump both together on every OTA release.
// raw.githubusercontent edge-caches files ~5 min, so ota_apply can pair a fresh
// manifest with STALE module files: the app then reports the new version while
// running old code (and "check update" says up-to-date forever — exactly the
// "covers still broken after updating" trap). Detect the mismatch and re-apply
// from scratch, once per version, so a mixed bundle always heals itself.
const SRC_VERSION = "0.22.40";
// style.css carries a "MP_CSS <version>" marker: modules and css are fetched
// separately by ota_apply, so the CSS alone can be a stale cached copy (the
// version-const check above can't see that).
const _otaCss = document.getElementById("otaCss");
const _cssStale = !!_otaCss && _otaCss.textContent.indexOf("MP_CSS " + SRC_VERSION) < 0;
if (IS_NATIVE && window.__MP_OTA__ && (window.__MP_OTA__ !== SRC_VERSION || _cssStale)) {
  const k = "mpOtaHealed:" + window.__MP_OTA__ + ":" + SRC_VERSION;
  if (!sessionStorage.getItem(k)) {
    sessionStorage.setItem(k, "1");
    T.core.invoke("ota_rollback")
      .then(() => T.core.invoke("ota_apply"))
      .catch(() => {})
      .then(() => location.reload());
  }
}
// On a touch device a single tap should PLAY the row (like every mobile music
// app) — the desktop "click selects, double-click plays" model makes a tap only
// select, so users double-tap, the second tap lands on a neighbouring row, and
// the wrong ("random") track plays with no obvious way to change it.
const IS_TOUCH = IS_ANDROID || !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
const ANDROID_MUSIC_DIR = "/storage/emulated/0/Music";
function platformName() {
  if (IS_ANDROID) return "Android";
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (/win/.test(p)) return "Windows";
  if (/mac/.test(p)) return "macOS";
  if (/linux/.test(p)) return "Linux";
  return "Desktop";
}

const MOCK_TRACKS = [
  { path: "/demo/a.flac", title: "Aurora", artist: "Kioku", album: "Night Drive", duration_secs: 214, gain: 1 },
  { path: "/demo/b.mp3",  title: "Low Tide", artist: "Kioku", album: "Night Drive", duration_secs: 187, gain: 1 },
  { path: "/demo/c.opus", title: "Paper Planes", artist: "Halcyon", album: "Kites", duration_secs: 243, gain: 1 },
];

async function invoke(cmd, args) {
  if (IS_NATIVE) return T.core.invoke(cmd, args);
  if (cmd === "scan") return MOCK_TRACKS;
  if (cmd === "status") return { queued: 0, finished: false, position: 0, epoch: 0 };
  if (cmd === "scan_diff") return { new_tracks: [], present: MOCK_TRACKS.map(t => t.path) };
  if (cmd === "play") return 0;
  return null;
}

// ─── State ───
let library = [];
let folders = [];
let view = [];
let queue = [];
let curIndex = -1, preIndex = -1;
let expectedQueued = 0, queueSettled = false;
let curEpoch = 0; // tags the current sink; stale status polls are ignored
let playing = false, shuffle = false, normalize = true;
// Restored-from-last-session state: the track is shown paused at _resumePos but
// the engine hasn't started it yet — the first Play hard-starts it and seeks.
let _needsStart = false, _resumePos = 0;
let repeatMode = "off"; // off | all | one
let history = [];
let seeking = false;
const selected = new Set();
let anchorIdx = -1;
let active = { type: "library", id: "" }; // current view for highlighting

const $ = (s) => document.querySelector(s);
const S = () => SETTINGS.getSettings();

// ─── UI icons (inline SVG shapes — no emoji in the chrome) ───
const IC = {
  headphones: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>`,
  disc: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  note: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>`,
  search: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1l2.1-2.1m10-10 2.1-2.1"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  dl: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 21h16"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 7 2 2H6l2-2z"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>`,
  slash: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v9"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>`,
  filter: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
  link: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/></svg>`,
  image: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0 4 4m-4-4-4 4"/><path d="M4 3h16"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  list: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7"/></svg>`,
  repeat: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
  save: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 21h16"/></svg>`,
  radio: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><path d="M7 8a6 6 0 0 0 0 8M17 8a6 6 0 0 1 0 8M4.5 5a10 10 0 0 0 0 14M19.5 5a10 10 0 0 1 0 14"/></svg>`,
  music: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
};
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-ic]").forEach(el => { el.innerHTML = IC[el.dataset.ic] || ""; });
}
// Inline an SVG icon inside a button/menu label (aligned via .bic).
function ic(svg) { return `<span class="bic">${svg}</span>`; }

// ─── Player control icons (inline SVG, colored via currentColor) ───
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`;
const ICON_REPEAT = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`;
function setPlayIcon(on) { $("#playBtn").innerHTML = on ? ICON_PAUSE : ICON_PLAY; }
function updateRepeatBtn() {
  const b = $("#repeatBtn");
  b.classList.toggle("active", repeatMode !== "off");
  b.title = `Repeat: ${repeatMode}`;
  b.innerHTML = ICON_REPEAT + (repeatMode === "one" ? `<span class="rep-one">1</span>` : "");
}

// ─── Wall clock ───
const clock = { origin: 0, pausedAt: null };
function wallStart(atSec = 0) { clock.origin = performance.now() - atSec * 1000; clock.pausedAt = null; }
function wallPause() { if (clock.pausedAt === null) clock.pausedAt = performance.now(); }
function wallResume() { if (clock.pausedAt !== null) { clock.origin += performance.now() - clock.pausedAt; clock.pausedAt = null; } }
function wallSeek(sec) { clock.origin = performance.now() - sec * 1000; if (clock.pausedAt !== null) clock.pausedAt = performance.now(); }
function wallPos() { const now = clock.pausedAt !== null ? clock.pausedAt : performance.now(); return Math.max(0, (now - clock.origin) / 1000); }

// ─── helpers ───
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtDur(s) { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), x = String(s % 60).padStart(2, "0"); return `${m}:${x}`; }
function baseName(p) { return String(p || "").split("/").filter(Boolean).pop() || p; }
function inFolder(t, f) {
  // Normalize \ → / (and drop any trailing slash) before comparing: on Windows
  // both the source folder and the scanned track paths are stored with
  // backslashes ("D:\music", "D:\music\song.mp3"), so the old startsWith(f+"/")
  // never matched and every source showed 0 songs. Separator-agnostic now.
  const norm = s => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const tp = norm(t.path), fp = norm(f);
  return tp === fp || tp.startsWith(fp + "/");
}
function trackByPath(p) { return library.find(t => t.path === p) || onlineIndex.get(p) || view.find(t => t.path === p) || null; }
function gainFor(t) { if (!normalize) return 1.0; const g = t && Number(t.gain); return Number.isFinite(g) && g > 0 ? g : 1.0; }
function artColor(s) { let h = 0; for (const c of String(s || "?")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 42% 40%)`; }
function artInitial(t) { const s = (t.album || t.title || "?").trim(); return (s[0] || "♪").toUpperCase(); }

// ─── Album art (embedded cover, deduped per album, lazily fetched) ───
const coverCache = new Map(); // albumKey -> dataURL | "" (none/pending)
function albumKey(t) { return `${t.artist}|||${t.album}`; }
function setArtImg(el, url) {
  el.style.background = ""; el.textContent = ""; el.classList.add("has-cover");
  // Android WebView won't load network images → proxy them to a data: URL.
  if (IS_ANDROID && /^https?:\/\//.test(url)) {
    el.dataset.proxied = url;
    netThumb(url).then(d => { if (el.dataset.proxied === url) el.style.backgroundImage = `url("${d}")`; }).catch(() => {});
  } else {
    el.style.backgroundImage = `url("${url}")`;
  }
}
function setArtPlaceholder(el, t) { el.classList.remove("has-cover"); el.style.backgroundImage = ""; el.style.background = artColor(t.artist + t.album); el.textContent = artInitial(t); el.dataset.album = albumKey(t); }
function artCell(t) {
  // Background on a fixed-size box — the ONE recipe confirmed to render on the
  // user's old WebView (playlist covers). <img> inside these boxes did not.
  if (t.thumbnail && S().showArt) return `<div class="art has-cover" style="background-image:url('${esc(t.thumbnail)}')"></div>`;
  const k = albumKey(t);
  const cov = S().showArt ? coverCache.get(k) : "";
  if (cov) return `<div class="art has-cover" data-album="${esc(k)}" style="background-image:url('${cov}')"></div>`;
  return `<div class="art" data-album="${esc(k)}" style="background:${artColor(t.artist + t.album)}">${esc(artInitial(t))}</div>`;
}
function applyCover(key, url) {
  if (!url) return;
  document.querySelectorAll("#trackList .art, #upNextList .art").forEach(el => { if (el.dataset.album === key) setArtImg(el, url); });
  for (const sel of ["#npArt", "#ovArt"]) { const el = $(sel); if (el && el.dataset.album === key) setArtImg(el, url); }
}
function fetchCover(t) {
  if (isOnline(t.path)) return; // online art comes from the thumbnail URL
  const k = albumKey(t);
  if (coverCache.has(k)) { const u = coverCache.get(k); if (u) applyCover(k, u); return; }
  coverCache.set(k, ""); // reserve
  invoke("cover", { path: t.path }).then(url => { coverCache.set(k, url || ""); if (url) applyCover(k, url); }).catch(() => {});
}
// Covers load lazily as rows scroll into view (IntersectionObserver) instead of
// firing one file-read per album for the whole 1700-track list at once.
let artObserver = null;
function ensureArtObserver() {
  if (artObserver || typeof IntersectionObserver === "undefined") return;
  artObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      artObserver.unobserve(en.target);
      const key = en.target.dataset.album;
      if (!key || coverCache.get(key)) { if (key) applyCover(key, coverCache.get(key) || ""); continue; }
      const t = view.find(x => albumKey(x) === key) || library.find(x => albumKey(x) === key);
      if (t) fetchCover(t);
    }
  }, { root: $("#trackList"), rootMargin: "300px" });
}
function hydrateCovers() {
  if (!S().showArt) return;
  ensureArtObserver();
  const arts = document.querySelectorAll("#trackList .art[data-album]:not(.has-cover)");
  if (artObserver) arts.forEach(el => artObserver.observe(el));
  else { const seen = new Set(); for (const t of view.slice(0, 60)) { const k = albumKey(t); if (!seen.has(k)) { seen.add(k); fetchCover(t); } } }
}
function refreshView() { if (active.type === "source") openSource(active.id); else if (active.type === "playlist") openPlaylist(active.id); else if (active.type === "online") renderOnlineResults(); else showLibrary(); }

// The Android WebView won't load external network background-images, so YouTube
// covers (i.ytimg…) are proxied through the Rust backend into inline data: URLs
// (which DO render, like local covers). Desktop loads them natively → no-op.
const _netThumb = new Map();
// Only a handful of net_image fetches in flight at once: each call occupies a
// backend worker, and a 100-card search page firing them all simultaneously
// used to starve the pool — the first covers painted, the rest never resolved.
const _thumbQ = [];
let _thumbBusy = 0;
const THUMB_PARALLEL = 6;
function _thumbPump() {
  while (_thumbBusy < THUMB_PARALLEL && _thumbQ.length) {
    const job = _thumbQ.shift();
    _thumbBusy++;
    _thumbFetch(job.clean).then(job.res, job.rej).finally(() => { _thumbBusy--; _thumbPump(); });
  }
}
async function _thumbFetch(clean) {
  try {
    const d = await invoke("net_image", { url: clean });
    _netThumb.set(clean, d);
    return d;
  } catch (e) {
    // hq720.jpg only exists for HD uploads (404 otherwise) — mqdefault.jpg
    // exists for every video, 320×180, plenty for the card grids.
    const m = clean.match(/i\.ytimg\.com\/vi\/([\w-]{11})\//);
    if (!m) throw e;
    const fb = `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg`;
    if (fb === clean) throw e;
    const d = await invoke("net_image", { url: fb });
    _netThumb.set(clean, d);
    return d;
  }
}
async function netThumb(url) {
  // Any i.ytimg video thumb is normalised straight to /vi/<id>/mqdefault.jpg:
  // plain JPEG (WebViews choke on WebP data: URLs), 320×180 (plenty for the
  // card grids), and it exists for EVERY video — hq720 404s on non-HD uploads
  // and each 404 + fallback used to cost an extra round-trip per card.
  const idm = url.match(/i\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\//);
  const clean = idm ? `https://i.ytimg.com/vi/${idm[1]}/mqdefault.jpg` : url;
  const c = _netThumb.get(clean);
  if (c) return c;
  return new Promise((res, rej) => { _thumbQ.push({ clean, res, rej }); _thumbPump(); });
}
function proxyCovers(root) {
  const scope = root || document;
  // Song/video thumbnails are real <img> elements — universal, no WebView
  // background-painting or box-sizing quirks (the old device rendered fixed-size
  // background boxes like playlists but NOT the padding-ratio ones). Set the src
  // from the proxy on Android, straight from the network on desktop.
  scope.querySelectorAll("img[data-net]").forEach(el => {
    const src = el.dataset.net;
    if (!src || el.dataset.done === src) return;
    el.dataset.done = src;
    // Last resort when the proxy fails (offline burst, unknown host): point the
    // <img> at the network URL directly — some WebViews do load plain <img>
    // sources even though they refuse background-images.
    if (IS_ANDROID && /^https?:\/\//.test(src)) netThumb(src).then(d => { el.src = d; }).catch(() => { el.src = src; });
    else el.src = src;
  });
  // background-image covers (songs, videos, playlists, artist avatar,
  // now-playing, download rows) — all fixed-height boxes. EVERY remote cover
  // is proxied to a data: URL on EVERY platform: network background-images
  // are unreliable across the engines this app actually runs on (old Android
  // WebView blocks them all; the user's desktop WebKitGTK — NVIDIA/Wayland,
  // broken EGL in the container — stopped painting them too, whatever the URL
  // form). data: URLs are the one path that provably renders everywhere
  // (local covers, now-playing art). net_image caches per URL, so a page of
  // results costs one fetch per unique thumb.
  scope.querySelectorAll(".art.has-cover, .yc-thumb, .pc-thumb, .ac-avatar, .pd-cover, .pd-thumb, .np-art.has-cover, .ov-art.has-cover, .dl-cover.has-cover").forEach(el => {
    const m = String(el.style.backgroundImage || "").match(/url\(['"]?(https:\/\/[^'")]+)['"]?\)/);
    if (!m || el.dataset.proxied === m[1]) return;
    const src = m[1];
    el.dataset.proxied = src;
    netThumb(src).then(d => { el.style.backgroundImage = `url("${d}")`; }).catch(() => { delete el.dataset.proxied; });
  });
}

// ─── Online tracks (YouTube via yt-dlp, same approach as play_yt_audio.sh) ───
// Online tracks live under pseudo-paths "yt:<videoId>" so queue/playlist/selection
// logic works unchanged. Metadata for playlist members persists in store "online".
const onlineIndex = new Map(); // "yt:<id>" -> track
function isOnline(p) { return String(p || "").startsWith("yt:"); }
function ytId(p) { return String(p).slice(3); }
function onlineFromResult(r) { return { path: "yt:" + r.id, title: r.title, artist: r.artist, album: "YouTube", duration_secs: r.duration_secs, gain: 1, thumbnail: r.thumbnail, views: r.views || 0 }; }
function ensureOnlineTrack(p) {
  let t = trackByPath(p) || onlineIndex.get(p);
  if (!t && isOnline(p)) {
    const id = ytId(p);
    t = { path: p, title: id ? `YouTube Track (${id})` : p, artist: "YouTube", album: "YouTube", duration_secs: 0, gain: 1, thumbnail: "" };
    onlineIndex.set(p, t);
  }
  return t;
}
function fmtViews(n) {
  n = Number(n) || 0;
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K views`;
  return `${n} views`;
}
async function saveOnline() {
  // Persist the whole index (capped): it also restores title/artist/artwork of
  // downloaded mp3 files that have no embedded tags (see enrichLibrary).
  const entries = [...onlineIndex.entries()].slice(-4000);
  await storeSave("online", JSON.stringify(Object.fromEntries(entries)));
}
async function loadOnline() {
  const raw = await storeLoad("online");
  if (raw) { try { const d = JSON.parse(raw); for (const k of Object.keys(d)) onlineIndex.set(k, d[k]); } catch {} }
}

// ─── Resume where you left off (Settings → Playback) ───
// Persist the current queue + track + position so the next launch restores it,
// PAUSED, at the same spot. Saved on pause / track change / periodically.
let _lastSavePos = -1;
function savePlayback() {
  if (!S().resumePlayback) return;
  if (curIndex < 0 || !queue.length) { storeSave("playback", ""); return; }
  const pos = Math.round(wallPos());
  if (pos === _lastSavePos && !playing) return; // avoid redundant writes
  _lastSavePos = pos;
  storeSave("playback", JSON.stringify({ queue, index: curIndex, position: pos, shuffle }));
}
async function restorePlayback() {
  if (!S().resumePlayback) return;
  const raw = await storeLoad("playback");
  if (!raw) return;
  let st; try { st = JSON.parse(raw); } catch { return; }
  if (!st || !Array.isArray(st.queue) || !st.queue.length || st.index == null) return;
  queue = st.queue;
  curIndex = Math.min(Math.max(0, st.index), queue.length - 1);
  shuffle = !!st.shuffle; $("#shuffleBtn").classList.toggle("active", shuffle);
  const t = trackByPath(effectivePath(queue[curIndex])) || trackByPath(queue[curIndex]);
  if (!t) { queue = []; curIndex = -1; return; }
  _resumePos = Math.max(0, st.position || 0);
  _needsStart = true;
  updateNowPlaying(t, queue[curIndex]);   // show metadata (this resets the seek bar)
  playing = false; setPlayIcon(false);
  wallStart(_resumePos); wallPause();      // freeze the wall clock at the saved spot
  renderSeek(_resumePos);
  updatePlayingRow();
}

// ─── Listening history (Settings → Playback: keep 0…1000 titles) ───
let history2 = [];
async function loadHistory() {
  const raw = await storeLoad("history");
  if (raw) { try { history2 = JSON.parse(raw); } catch {} }
  if (!Array.isArray(history2)) history2 = [];
}
function saveHistory() { storeSave("history", JSON.stringify(history2.slice(0, 1000))); }
function recordHistory(t, path) {
  const lim = Math.max(0, Math.min(1000, Number(S().historyLimit) || 0));
  if (!lim) { if (history2.length) { history2 = []; saveHistory(); } return; }
  if (!t) return;
  const p = path || t.path;
  history2 = history2.filter(h => h.path !== p); // most-recent, no dupes
  history2.unshift({ path: p, title: t.title || "", artist: t.artist || "", album: t.album || "", thumbnail: t.thumbnail || "", duration_secs: t.duration_secs || 0, at: Date.now() });
  if (history2.length > lim) history2.length = lim;
  saveHistory();
}
function showHistory() {
  active = { type: "history", id: "" };
  markActive();
  selected.clear();
  const tracks = history2.map(h => trackByPath(h.path) || h).filter(Boolean);
  setViewHead({ icon: IC.clock, title: "Recently played", subtitle: `${tracks.length} track${tracks.length === 1 ? "" : "s"}`, actions: tracks.length ? `<button id="histClear" class="btn-line sm">Clear history</button>` : "" });
  renderTracks(tracks, true); // keep recency order (presorted)
  const cb = $("#histClear"); if (cb) cb.addEventListener("click", () => { history2 = []; saveHistory(); showHistory(); });
}
// Downloaded files are named "Title [videoId].mp3"; when the mp3 has no tags
// (older downloads), borrow title/artist/artwork from the online metadata.
function enrichLibrary() {
  let changed = 0;
  for (const t of library) {
    if (t.thumbnail) continue;
    const m = String(t.path).match(/\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/);
    if (!m) continue;
    const o = onlineIndex.get("yt:" + m[1]);
    if (!o) continue;
    if (t.title.includes(`[${m[1]}]`)) t.title = o.title;
    if (!t.artist || t.artist === "Unknown Artist") t.artist = o.artist;
    if (!t.album || t.album === "Unknown Album") t.album = "YouTube";
    t.thumbnail = o.thumbnail;
    changed++;
  }
  return changed;
}

// Playlists store absolute file paths. When the user moves their music to a new
// folder (or a drive that held it is unplugged and the files now live elsewhere,
// e.g. ~/Desktop/music), those stored paths go dead and the tracks silently
// vanish from the playlist view (openPlaylist drops any path not in the library).
// Re-point every dead local path to the library file carrying the same
// "[videoId]" tag; fall back to a same-filename match for non-YouTube files.
const VID_RE = /\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/i;
function relinkPlaylists() {
  const known = new Set(library.map(t => t.path));
  const byVid = new Map(), byBase = new Map();
  for (const t of library) {
    const m = String(t.path).match(VID_RE);
    if (m && !byVid.has(m[1])) byVid.set(m[1], t.path);
    const b = String(t.path).split("/").pop();
    if (b && !byBase.has(b)) byBase.set(b, t.path);
  }
  const dead = new Set();
  for (const pl of PL.getPlaylists())
    for (const p of pl.paths)
      if (!isOnline(p) && !known.has(p)) dead.add(p);
  let fixed = 0;
  for (const p of dead) {
    const m = String(p).match(VID_RE);
    const target = (m && byVid.get(m[1])) || byBase.get(String(p).split("/").pop());
    if (target && target !== p) { PL.replacePath(p, target); fixed++; }
  }
  return fixed;
}

// ─── In-app dialogs (replaces the ugly native prompt()/confirm() popups) ───
let _dlgResolve = null, _dlgHasInput = false;
function dlgClose(val) {
  $("#dlgModal").hidden = true;
  const r = _dlgResolve; _dlgResolve = null;
  r?.(val);
}
function askText(title, { placeholder = "", value = "", ok = "OK" } = {}) {
  return new Promise(res => {
    _dlgResolve = res; _dlgHasInput = true;
    $("#dlgTitle").textContent = title;
    $("#dlgMsg").hidden = true;
    const inp = $("#dlgInput");
    inp.hidden = false; inp.placeholder = placeholder; inp.value = value;
    $("#dlgOk").textContent = ok;
    $("#dlgCancel").textContent = "Cancel";
    $("#dlgModal").hidden = false;
    setTimeout(() => inp.focus(), 0);
  });
}
function askConfirm(title, msg = "", ok = "OK", cancel = "Cancel") {
  return new Promise(res => {
    _dlgResolve = res; _dlgHasInput = false;
    $("#dlgTitle").textContent = title;
    $("#dlgMsg").textContent = msg; $("#dlgMsg").hidden = !msg;
    $("#dlgInput").hidden = true;
    $("#dlgOk").textContent = ok;
    $("#dlgCancel").textContent = cancel;
    $("#dlgModal").hidden = false;
    setTimeout(() => $("#dlgOk").focus(), 0);
  });
}
function wireDialogs() {
  $("#dlgOk").addEventListener("click", () => dlgClose(_dlgHasInput ? $("#dlgInput").value.trim() : true));
  $("#dlgCancel").addEventListener("click", () => dlgClose(_dlgHasInput ? null : false));
  $("#dlgInput").addEventListener("keydown", e => { if (e.key === "Enter") dlgClose($("#dlgInput").value.trim()); });
  $("#dlgModal").addEventListener("click", e => { if (e.target.id === "dlgModal") dlgClose(null); });
}

function flash(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  // Hard cap so a stray long string (e.g. a stream URL) can never blow up the UI.
  const s = String(msg);
  el.textContent = s.length > 200 ? s.slice(0, 200) + "…" : s;
  el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ─── View header ───
function setViewHead({ icon = "", title = "", subtitle = "", actions = "" }) {
  $("#viewHead").innerHTML = `<div class="vh-icon">${icon}</div><div class="vh-txt"><div class="vh-title">${esc(title)}</div><div class="vh-sub">${esc(subtitle)}</div></div>${actions ? `<div class="vh-actions">${actions}</div>` : ""}`;
}

// ─── Sorting ───
let sortMode = "default";
function sortTracks(list) {
  const c = (a, b, k) => String(a[k] || "").localeCompare(String(b[k] || ""), undefined, { sensitivity: "base" });
  switch (sortMode) {
    case "title": return list.sort((a, b) => c(a, b, "title"));
    case "title-desc": return list.sort((a, b) => c(b, a, "title"));
    case "artist": return list.sort((a, b) => c(a, b, "artist") || c(a, b, "album") || c(a, b, "title"));
    case "album": return list.sort((a, b) => c(a, b, "album") || c(a, b, "title"));
    case "dur": return list.sort((a, b) => (a.duration_secs || 0) - (b.duration_secs || 0));
    case "dur-desc": return list.sort((a, b) => (b.duration_secs || 0) - (a.duration_secs || 0));
    default: return list; // natural order (playlist / scan order)
  }
}

// ─── Track list ───
// ─── Pinned tracks (library + playlists) ───
// Pins live in settings under "pins": { lib: [paths], "pl:<id>": [paths] }.
// Pinned tracks float to the top of their view, in pin order, after sorting.
function pinContextKey() {
  if (active.type === "playlist") return "pl:" + active.id;
  if (active.type === "library") return "lib";
  return null;
}
function pinsFor(key) { const m = S().pins || {}; return Array.isArray(m[key]) ? m[key] : []; }
function setPins(key, arr) {
  const m = { ...(S().pins || {}) };
  if (arr.length) m[key] = arr; else delete m[key];
  SETTINGS.setSetting("pins", m);
}
let _pinSet = new Set();
function applyPins(list) {
  const key = pinContextKey();
  const order = key ? pinsFor(key) : [];
  _pinSet = new Set(order);
  if (!order.length) return list;
  const pos = new Map(order.map((p, i) => [p, i]));
  const pinned = list.filter(t => pos.has(t.path)).sort((a, b) => pos.get(a.path) - pos.get(b.path));
  return pinned.length ? [...pinned, ...list.filter(t => !pos.has(t.path))] : list;
}

// ─── Drag-to-reorder (playlists only) ───
// A row can only be moved when the rendered order still mirrors the playlist's
// own `paths` order. Rather than testing sort/pins/search separately, we map
// every visible row back to a distinct index in pl.paths and require that map
// to be strictly increasing — one invariant that covers all three at once, and
// also survives two traps: openPlaylist drops unresolvable paths with
// .filter(Boolean) (so view index ≠ paths index), and allowDup lets the same
// path appear twice (so indexOf alone would move the wrong copy).
// The library is reorderable on the same terms as a playlist: its backing array
// is persisted whole by saveLibrary(), so moving an entry IS the saved order —
// no extra setting to keep in sync.
let _plSrc = null; // { kind: "playlist"|"library", id, idx: [srcIndexForViewRow0, ...] } | null

function _computeOrderMap(paths) {
  const nextFrom = new Map();
  const idx = [];
  let prev = -1;
  for (const t of view) {
    const from = nextFrom.get(t.path) || 0;
    const i = paths.indexOf(t.path, from);
    if (i < 0 || i <= prev) return null; // unmappable or reordered → no drag
    nextFrom.set(t.path, i + 1);
    idx.push(i);
    prev = i;
  }
  return idx;
}

function canReorder() {
  if (!_plSrc) return false;
  if (_plSrc.kind === "playlist") return active.type === "playlist" && _plSrc.id === active.id;
  return active.type === "library";
}

// Drag state. `from` is a VIEW index; it is translated through _plSrc.idx only
// at drop time, so the live re-slicing of the virtual list cannot invalidate it.
// Both indices are VIEW indices, never element references: a long list is
// virtualized, and auto-scrolling during a drag makes _virtSlice() rewrite the
// host's innerHTML, destroying every row — including the one being dragged.
// Indices survive that; DOM nodes do not. `view` itself is never mutated
// mid-drag, so an index stays valid for the whole gesture.
let _drag = null; // { from, overIdx, after }

function _clearDropMark() {
  document.querySelectorAll("#trackList .drop-before, #trackList .drop-after")
    .forEach(el => el.classList.remove("drop-before", "drop-after"));
}

function _rowByIdx(i) {
  return i == null ? null : document.querySelector(`#trackList .track[data-idx="${i}"]`);
}

// Re-apply the drag decorations after the virtual list has rebuilt its rows.
function _repaintDrag() {
  if (!_drag) return;
  _clearDropMark();
  _rowByIdx(_drag.from)?.classList.add("dragging");
  if (_drag.overIdx != null) _rowByIdx(_drag.overIdx)?.classList.add(_drag.after ? "drop-after" : "drop-before");
}

// Rows outside the rendered window do not exist in the DOM, so a long list can
// only be traversed by scrolling. Nudge the viewport while the pointer sits
// near an edge; the scroll handler re-slices and materialises the next rows.
function _dragAutoScroll(host, clientY) {
  const r = host.getBoundingClientRect();
  const EDGE = 60;
  let dy = 0;
  if (clientY < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - clientY) / 3);
  else if (clientY > r.bottom - EDGE) dy = Math.ceil((clientY - (r.bottom - EDGE)) / 3);
  if (!dy) return;
  host.scrollTop += dy;
}

function wireReorder(host) {
  host.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".track");
    if (!row || !canReorder()) return;
    _drag = { from: Number(row.dataset.idx), overIdx: null, after: false };
    row.classList.add("dragging");
    // Firefox refuses to start a drag unless some data is set.
    try { e.dataTransfer.setData("text/plain", row.dataset.path || ""); } catch {}
    e.dataTransfer.effectAllowed = "move";
  });

  host.addEventListener("dragover", (e) => {
    if (!_drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    _dragAutoScroll(host, e.clientY);
    const row = e.target.closest(".track");
    if (!row || row.classList.contains("dragging")) return;
    const idx = Number(row.dataset.idx);
    if (!Number.isInteger(idx)) return;
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (_drag.overIdx === idx && _drag.after === after) return;
    _clearDropMark();
    _drag.overIdx = idx; _drag.after = after;
    row.classList.add(after ? "drop-after" : "drop-before");
  });

  host.addEventListener("drop", (e) => {
    if (!_drag) return;
    e.preventDefault();
    const from = _drag.from, after = _drag.after, overIdx = _drag.overIdx;
    _endDrag();
    if (overIdx == null || !canReorder()) return;
    if (!Number.isInteger(overIdx) || overIdx === from) return;

    const map = _plSrc.idx;
    const realFrom = map[from];
    const anchor = map[overIdx];
    if (realFrom === undefined || anchor === undefined) return;
    // reorderPlaylist splices the item OUT first, so every index above it
    // shifts down by one. Compensate before choosing the insertion point.
    const beforeAnchor = realFrom < anchor ? anchor - 1 : anchor;
    const to = after ? beforeAnchor + 1 : beforeAnchor;
    if (to === realFrom) return;
    if (_plSrc.kind === "playlist") {
      PL.reorderPlaylist(active.id, realFrom, to);
      openPlaylist(active.id);
    } else {
      // Same splice-out-then-in semantics as reorderPlaylist, so the index
      // maths above holds for both.
      const [moved] = library.splice(realFrom, 1);
      if (moved === undefined) return;
      library.splice(to, 0, moved);
      saveLibrary();
      showLibrary();
    }
  });

  // dragend fires on the SOURCE row, so a re-slice that removed it would leave
  // the gesture state stuck (stale drop marks, next click misread as a drag).
  // Listen on the document instead — that fires regardless of what happened to
  // the row, including when the drag is cancelled with Escape or dropped
  // outside the list.
  document.addEventListener("dragend", _endDrag);
  document.addEventListener("drop", (e) => { if (_drag) { e.preventDefault(); _endDrag(); } });
}

function _endDrag() {
  _clearDropMark();
  document.querySelectorAll("#trackList .dragging").forEach(el => el.classList.remove("dragging"));
  _drag = null;
}

function _rowHtml(t, i, nowPath) {
  const isNow = nowPath === t.path;
  const blk = isBlocked(t.path);
  const pin = _pinSet.has(t.path);
  const isStream = isStreamTrack(t.path);
  return `<div class="track ${isNow ? "playing" : ""} ${selected.has(t.path) ? "selected" : ""} ${blk ? "blocked" : ""} ${pin ? "pinned" : ""}"${canReorder() ? ' draggable="true"' : ""} data-path="${esc(t.path)}" data-idx="${i}">
    <div class="tk-idx">${pin ? `<span class="idx-num idx-pin">${IC.pin}</span>` : `<span class="idx-num">${i + 1}</span>`}<span class="idx-play">${IC.play}</span></div>
    ${artCell(t)}
    <div class="meta"><div class="t">${blk ? "🚫 " : ""}${esc(t.title)}${isStream ? ` <span class="badge-stream" title="Online / Streamed track (Not downloaded)">☁ Stream</span>` : ""}</div><div class="s">${esc(t.artist)}</div></div>
    <div class="album">${esc(t.album)}</div>
    <span class="dur">${fmtDur(t.duration_secs)}</span>
    <button class="more" title="More" data-more="${i}">⋯</button>
  </div>`;
}

// ─── Virtualized list ───
// Rendering 1800+ rows at once made fast scrolling collapse to a few fps:
// every frame laid out and painted the entire list. Long lists render ONLY
// the on-screen window (± VIRT_BUF rows) between two spacer divs, re-sliced
// on scroll inside a rAF. Delegation, selection, playing-row and lazy covers
// all operate on the rendered rows, so they keep working unchanged.
const VIRT_MIN = 250, VIRT_BUF = 30, VIRT_SLACK = 8;
let _virt = null; // { rowH, start, end, raf }
function _virtSlice() {
  const v = _virt; if (!v) return;
  const host = $("#trackList");
  let padTop = $("#virtTop"), padBot = $("#virtBot"), rowsCont = $("#virtRows");
  if (!padTop || !padBot || !rowsCont) {
    host.innerHTML = `<div id="virtTop" class="virt-pad"></div><div id="virtRows"></div><div id="virtBot" class="virt-pad"></div>`;
    padTop = $("#virtTop"); padBot = $("#virtBot"); rowsCont = $("#virtRows");
  }
  const top = host.scrollTop, vh = host.clientHeight || 600;
  const vpStart = Math.floor(top / v.rowH);
  const vpEnd = Math.ceil((top + vh) / v.rowH);
  // Hysteresis: the rendered slice is VIRT_BUF rows wider than the viewport
  // on each side, and is only rebuilt once the viewport gets within
  // VIRT_SLACK rows of its edge — not on every scrolled pixel.
  if (v.start >= 0) {
    const safeLo = v.start === 0 ? 0 : v.start + VIRT_SLACK;
    const safeHi = v.end >= view.length ? view.length : v.end - VIRT_SLACK;
    if (vpStart >= safeLo && vpEnd <= safeHi) return; // comfortably inside
  }
  const start = Math.max(0, vpStart - VIRT_BUF);
  const end = Math.min(view.length, vpEnd + VIRT_BUF);
  if (start === v.start && end === v.end) return;

  v.start = start; v.end = end;
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;

  // The two spacers always sum with the rendered rows to view.length * rowH, so
  // row N sits at N * rowH no matter which window is mounted. Re-slicing moves
  // nothing, and scrollTop must therefore be left ALONE here. An earlier
  // revision added a `scrollTop += (start - prevStart) * rowH` compensation to
  // undo the jump caused by the browser's own scroll anchoring; that treated the
  // symptom and introduced its own — up to VIRT_BUF rows of unrequested travel,
  // which a scrollbar drag then fought, snapping the view back on every small
  // move. Anchoring is now off (overflow-anchor: none on .tracklist) and no
  // compensation belongs here.
  padTop.style.height = `${start * v.rowH}px`;
  padBot.style.height = `${Math.max(0, view.length - end) * v.rowH}px`;
  rowsCont.innerHTML = view.slice(start, end).map((t, k) => _rowHtml(t, start + k, nowPath)).join("");

  _sm.target = host.scrollTop;
  hydrateCovers();
  proxyCovers(host);
  // These rows replaced the ones that carried the drag decorations.
  _repaintDrag();
}

// The column headers and the sort row belong to the track list: both must
// vanish together for views that are not a track list (YouTube card grids,
// playlist-detail panes, empty states), or the sorter floats over unrelated UI.
function showListChrome(on) {
  $("#listHead").style.display = on ? "" : "none";
  const t = $("#listTools");
  if (t) t.style.display = on && !t.hidden ? "" : "none";
}

function renderTracks(list, presorted = false) {
  const src = filterBlocked(list);
  view = applyPins(presorted ? [...src] : sortTracks([...src]));
  list = view;
  // Decide up front whether these rows are drag-reorderable: _rowHtml reads it
  // while building the markup, so it has to be settled before we render.
  // A filtered view is excluded on purpose — dropping between two visible rows
  // when hidden rows sit between them puts the track somewhere the user cannot
  // see, which reads as a bug even though the index maths is right.
  _plSrc = null;
  if (!$("#search").value.trim()) {
    if (active.type === "playlist") {
      const pl = PL.getPlaylists().find(p => p.id === active.id);
      // Hidden not-downloaded entries filter this view just as the search box
      // does, so reordering is off here for the same reason: _computeOrderMap
      // would still resolve every row, but a drop between two visible rows
      // lands the track on the far side of entries the user cannot see.
      const complete = pl && view.length === pl.paths.length;
      const idx = complete ? _computeOrderMap(pl.paths) : null;
      if (idx) _plSrc = { kind: "playlist", id: active.id, idx };
    } else if (active.type === "library") {
      const idx = _computeOrderMap(library.map(t => t.path));
      if (idx) _plSrc = { kind: "library", id: "", idx };
    }
  }
  updateCount();
  const host = $("#trackList");
  host.classList.remove("yt-grid"); // leave mini-YouTube card mode
  showListChrome(!!list.length);
  _virt = null;
  if (!list.length) { host.innerHTML = `<div class="empty"><div class="empty-ico">${IC.music}</div>Nothing here yet.</div>`; return; }
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  // Online results keep the full render: separators/playlist cards are
  // injected between rows there and the list is small anyway.
  const savedTop = host.scrollTop;
  if (list.length >= VIRT_MIN && active.type !== "online") {
    const estPitch = _virt?.rowH || 56;
    host.innerHTML = `<div id="virtTop" class="virt-pad"></div><div id="virtRows">${list.slice(0, 2).map((t, i) => _rowHtml(t, i, nowPath)).join("")}</div><div id="virtBot" class="virt-pad" style="height:${Math.max(0, list.length - 2) * estPitch}px"></div>`;
    const rows = host.querySelectorAll(".track");
    const pitch = rows.length > 1
      ? rows[1].offsetTop - rows[0].offsetTop
      : (rows[0]?.offsetHeight || 56);
    _virt = { rowH: Math.max(24, pitch), start: -1, end: -1, raf: 0 };
    if (savedTop > 0) host.scrollTop = savedTop;
    _virtSlice();
    if (savedTop > 0 && Math.abs(host.scrollTop - savedTop) > 1) host.scrollTop = savedTop;
  } else {
    host.innerHTML = list.map((t, i) => _rowHtml(t, i, nowPath)).join("");
    if (savedTop > 0) host.scrollTop = savedTop;
  }

  _sm.el = host;
  _sm.target = host.scrollTop;

  // Rows use event delegation (wired once in init) — attaching thousands of
  // per-row listeners on every render made big libraries stutter.
  updatePlayingRow();
  hydrateCovers();
  proxyCovers(host);
}

function wireTrackList() {
  const host = $("#trackList");
  // Virtualized lists re-slice their window on scroll (one rAF max in flight).
  host.addEventListener("scroll", () => {
    if (!_sm.raf) { _sm.el = host; _sm.target = host.scrollTop; }
    if (!_virt || _virt.raf) return;
    _virt.raf = requestAnimationFrame(() => { if (_virt) { _virt.raf = 0; _virtSlice(); } });
  }, { passive: true });
  wireReorder(host);
  host.addEventListener("click", (e) => {
    const playBtn = e.target.closest("[data-play]");
    if (playBtn) { e.stopPropagation(); playFrom(Number(playBtn.dataset.play)); return; }
    const more = e.target.closest("[data-more]");
    if (more) {
      e.stopPropagation();
      const idx = Number(more.dataset.more);
      ensureSelected(view[idx]?.path, idx);
      const r = more.getBoundingClientRect();
      openContextMenu(r.left, r.bottom);
      return;
    }
    const row = e.target.closest(".track");
    if (row) {
      // Touch: tap plays immediately; long-press opens the context menu (below).
      if (IS_TOUCH && !e.ctrlKey && !e.metaKey && !e.shiftKey) { playFrom(Number(row.dataset.idx)); return; }
      rowClick(e, Number(row.dataset.idx), row.dataset.path);
    }
  });
  host.addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-more]")) return;
    const row = e.target.closest(".track");
    if (row) playFrom(Number(row.dataset.idx));
  });
  host.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".track");
    if (!row) return;
    e.preventDefault();
    ensureSelected(row.dataset.path, Number(row.dataset.idx));
    openContextMenu(e.clientX, e.clientY);
  });
}

// Cheap in-place update of the "now playing" row highlight — avoids re-rendering
// the whole list (1000+ rows) on every track change or play/pause.
function updatePlayingRow() {
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  document.querySelectorAll("#trackList .track").forEach(el => el.classList.toggle("playing", el.dataset.path === nowPath));
  document.body.classList.toggle("paused", !playing);
}

function updateCount() {
  // Only the selection count is shown. The permanent "N tracks" readout was
  // redundant with the per-view subtitle and just crowded the search bar.
  const n = selected.size;
  $("#count").textContent = n ? `${n} selected` : "";
}
function refreshSelectionUI() {
  document.querySelectorAll("#trackList .track").forEach(el => el.classList.toggle("selected", selected.has(el.dataset.path)));
  updateCount();
}

// ─── Selection ───
function rowClick(e, idx, path) {
  if (e.ctrlKey || e.metaKey) { if (selected.has(path)) selected.delete(path); else selected.add(path); anchorIdx = idx; }
  else if (e.shiftKey && anchorIdx >= 0) { const a = Math.min(anchorIdx, idx), b = Math.max(anchorIdx, idx); selected.clear(); for (let i = a; i <= b; i++) if (view[i]) selected.add(view[i].path); }
  else {
    selected.clear(); selected.add(path); anchorIdx = idx;
    // Warm up the stream URL so a double-click play is near-instant.
    if (isOnline(path) && IS_NATIVE) invoke("prefetch_stream", { id: ytId(path) }).catch(() => {});
  }
  refreshSelectionUI();
}
function ensureSelected(path, idx) { if (path && !selected.has(path)) { selected.clear(); selected.add(path); anchorIdx = idx; refreshSelectionUI(); } }

// ─── Context menu ───
// The on-disk file backing a selected path (the path itself if it's local, or
// its downloaded twin for an online path), plus the videoId if any.
function localFileFor(p) { return isOnline(p) ? libraryLocalFor(ytId(p)) : p; }
function isStreamTrack(p) { return isOnline(p) && !localFileFor(p); }
function videoIdOf(p) {
  if (isOnline(p)) return ytId(p);
  const m = String(p).match(/\[([A-Za-z0-9_-]{11})\]/);
  return m ? m[1] : null;
}
// Delete the on-disk files for these paths. Remaining playlist references are
// reverted to the online stream (via [videoId]) so nothing dangles and the
// track stays playable where it was.
async function deleteLocalFiles(paths) {
  let removed = 0;
  for (const p of paths) {
    const file = localFileFor(p);
    if (!file) continue;
    try { await invoke("delete_file", { path: file }); }
    catch (e) { console.error("[delete]", file, e); flash(`Couldn't delete a file: ${e}`); continue; }
    removed++;
    const vid = videoIdOf(p);
    const t = library.find(x => x.path === file);
    if (vid) {
      const online = "yt:" + vid;
      if (!onlineIndex.has(online)) onlineIndex.set(online, { path: online, title: t?.title || baseName(file), artist: t?.artist || "Unknown Artist", album: "YouTube", duration_secs: t?.duration_secs || 0, gain: 1, thumbnail: t?.thumbnail || "" });
      PL.replacePath(file, online); // keep it in playlists, now as a stream
    }
    library = library.filter(x => x.path !== file);
  }
  if (removed) { await saveLibrary(); await saveOnline(); }
  return removed;
}

function openContextMenu(x, y) {
  const paths = [...selected]; if (!paths.length) return;
  const menu = $("#ctxMenu");
  const pls = PL.getPlaylists();
  const nOnline = paths.filter(isOnline).length;
  const inPlaylist = active.type === "playlist";
  const inLibrary = active.type === "library";
  const nLocal = paths.map(localFileFor).filter(Boolean).length;
  const nsfx = paths.length > 1 ? paths.length + " tracks" : "track";
  menu.innerHTML =
    `<div class="ctx-item" data-play="1">${ic(IC.play)}Play</div>` +
    (nOnline ? `<div class="ctx-item" data-dl="1">${ic(IC.save)}Download ${nOnline > 1 ? nOnline + " tracks" : "track"} locally</div>` : "") +
    (paths.length === 1 && localFileFor(paths[0]) ? `<div class="ctx-item" data-reveal="1">${ic(IC.folder)}Open file location</div>` : "") +
    // ── removal / deletion ──
    // An online track in the library has no local file to delete and no playlist
    // to leave, so without this there would be no way to get rid of one — and
    // they arrive on their own now, adopted from playlists.
    ((inPlaylist || nLocal || (inLibrary && nOnline)) ? `<div class="ctx-sep"></div>` : "") +
    (inLibrary && nOnline ? `<div class="ctx-item" data-rm="lib">${ic(IC.minus)}Remove ${nOnline > 1 ? nOnline + " online tracks" : "online track"} from library</div>` : "") +
    (inPlaylist ? `<div class="ctx-item" data-rm="pl">${ic(IC.minus)}Remove from this playlist</div>` : "") +
    (nLocal ? `<div class="ctx-item ctx-danger" data-rm="local">${ic(IC.trash)}Delete local file${nLocal > 1 ? "s" : ""}${inPlaylist ? " (keep in playlist)" : ""}</div>` : "") +
    (inPlaylist && nLocal ? `<div class="ctx-item ctx-danger" data-rm="both">${ic(IC.trash)}Remove from playlist + delete local</div>` : "") +
    // ── block / unblock ──
    `<div class="ctx-sep"></div>` +
    (paths.every(isBlocked)
      ? `<div class="ctx-item" data-block="off">${ic(IC.play)}Unblock ${nsfx}</div>`
      : `<div class="ctx-item" data-block="on">${ic(IC.slash)}Block ${nsfx} (hide + can't play)</div>`) +
    // ── pin to top (library + playlist views) ──
    (pinContextKey()
      ? (paths.every(p => pinsFor(pinContextKey()).includes(p))
        ? `<div class="ctx-item" data-pin="off">${ic(IC.pin)}Unpin ${nsfx}</div>`
        : `<div class="ctx-item" data-pin="on">${ic(IC.pin)}Pin ${nsfx} to top</div>`)
      : "") +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-label">Add ${nsfx} to</div>` +
    pls.map(p => `<div class="ctx-item" data-add="${p.id}">${ic(IC.note)}${esc(p.name)}</div>`).join("") +
    `<div class="ctx-item" data-add="__new">${ic(IC.plus)}New playlist…</div>`;
  placeCtx(menu, x, y);
  menu.querySelector("[data-dl]")?.addEventListener("click", () => { downloadTracks(paths.filter(isOnline)); closeCtx(); });
  menu.querySelector("[data-play]")?.addEventListener("click", () => { const i = view.findIndex(t => t.path === paths[0]); if (i >= 0) playFrom(i); closeCtx(); });
  menu.querySelector("[data-reveal]")?.addEventListener("click", () => { revealPath(localFileFor(paths[0])); closeCtx(); });
  menu.querySelector("[data-block]")?.addEventListener("click", (e) => {
    const on = e.currentTarget.dataset.block === "on";
    closeCtx();
    setBlocked(paths, on);
    // If a currently-playing track just got blocked, skip past it.
    if (on && curIndex >= 0 && paths.includes(queue[curIndex])) next();
    selected.clear(); refreshView();
    flash(on ? `Blocked ${nsfx}` : `Unblocked ${nsfx}`);
  });

  menu.querySelector("[data-pin]")?.addEventListener("click", (e) => {
    const on = e.currentTarget.dataset.pin === "on";
    const key = pinContextKey();
    closeCtx();
    if (!key) return;
    const cur = pinsFor(key);
    setPins(key, on ? [...paths.filter(p => !cur.includes(p)), ...cur] : cur.filter(p => !paths.includes(p)));
    selected.clear(); refreshView();
    flash(on ? `Pinned ${nsfx} to top` : `Unpinned ${nsfx}`);
  });

  menu.querySelector('[data-rm="lib"]')?.addEventListener("click", async () => {
    closeCtx();
    const online = paths.filter(isOnline);
    // A track still referenced by a playlist would simply be re-adopted the
    // next time the library is opened, so say that instead of pretending.
    const stillLinked = online.filter(p => PL.getPlaylists().some(pl => pl.paths.includes(p)));
    if (stillLinked.length && !await askConfirm(
      `Remove ${online.length > 1 ? online.length + " online tracks" : "this online track"} from your library?`,
      `${stillLinked.length === online.length ? "They are" : `${stillLinked.length} of them are`} still in a playlist, so ${stillLinked.length > 1 ? "they" : "it"} will come back the next time you open your library. Remove ${stillLinked.length > 1 ? "them" : "it"} from the playlist too to keep ${stillLinked.length > 1 ? "them" : "it"} out.`,
      "Remove")) return;
    const drop = new Set(online);
    library = library.filter(t => !drop.has(t.path));
    selected.clear();
    await saveLibrary();
    showLibrary();
    flash(`Removed ${online.length > 1 ? online.length + " online tracks" : "1 online track"} from library`);
  });
  menu.querySelector('[data-rm="pl"]')?.addEventListener("click", () => {
    closeCtx();
    for (const p of paths) PL.removeFromPlaylist(active.id, p);
    saveOnline(); renderPlaylists(); openPlaylist(active.id);
    flash(`Removed ${nsfx} from playlist`);
  });
  menu.querySelector('[data-rm="local"]')?.addEventListener("click", async () => {
    closeCtx();
    if (!await askConfirm(`Delete ${nLocal} local file${nLocal > 1 ? "s" : ""} from disk?`, "The track stays in your playlists (played from YouTube again).", "Delete")) return;
    const n = await deleteLocalFiles(paths);
    renderPlaylists(); refreshView(); if (n) flash(`Deleted ${n} local file${n > 1 ? "s" : ""}`);
  });
  menu.querySelector('[data-rm="both"]')?.addEventListener("click", async () => {
    closeCtx();
    if (!await askConfirm("Remove from playlist and delete the local file?", "This removes the track from this playlist and erases the file from disk.", "Delete")) return;
    for (const p of paths) PL.removeFromPlaylist(active.id, p);
    const n = await deleteLocalFiles(paths);
    // deleteLocalFiles reverted others to stream; also unlink those from THIS playlist.
    for (const p of paths) { const v = videoIdOf(p); if (v) PL.removeFromPlaylist(active.id, "yt:" + v); }
    saveOnline(); renderPlaylists(); refreshView();
    flash(`Removed ${nsfx}${n ? ` and deleted ${n} file${n > 1 ? "s" : ""}` : ""}`);
  });

  menu.querySelectorAll("[data-add]").forEach(it => it.addEventListener("click", async () => {
    let id = it.dataset.add;
    const isNew = id === "__new";
    if (isNew) { closeCtx(); const name = await askText("New playlist", { placeholder: "Playlist name", ok: "Create" }); if (!name) return; id = PL.createPlaylist(name).id; }
    else closeCtx();
    // Duplicate handling: if some are already in the target, ask add-again vs skip.
    let allowDup = false;
    const dups = isNew ? 0 : PL.countExisting(id, paths);
    if (dups > 0) {
      allowDup = await askConfirm(
        `${dups} of these ${paths.length === 1 ? "is" : "are"} already in the playlist`,
        "Add them again as duplicates? Choose Skip to add only the new ones.",
        "Add duplicates", "Skip duplicates");
      if (allowDup === null) return; // dialog dismissed
    }
    let n = 0; for (const p of paths) { const before = PL.countExisting(id, [p]); PL.addToPlaylist(id, p, allowDup); if (allowDup || !before) n++; }
    if (paths.some(isOnline)) saveOnline(); // keep online metadata across restarts
    const nm = PL.getPlaylists().find(p => p.id === id)?.name || "playlist";
    renderPlaylists();
    flash(n ? `Added ${n} track${n === 1 ? "" : "s"} to “${nm}”` : `Nothing added — already in “${nm}”`);
  }));
}
function closeCtx() { const m = $("#ctxMenu"); if (m && !m.hidden) { m.hidden = true; m.innerHTML = ""; } }

function placeCtx(menu, x, y) {
  menu.hidden = false;
  menu.style.left = Math.min(x, window.innerWidth - 224) + "px";
  menu.style.top = Math.min(y, window.innerHeight - Math.min(menu.offsetHeight + 8, 340)) + "px";
}

// Right-click menu for a sidebar playlist: everything you can do to it.
function openPlaylistCtx(x, y, id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const fw = followFor(id);
  const menu = $("#ctxMenu");
  menu.innerHTML =
    `<div class="ctx-item" data-a="open">${ic(IC.note)}Open</div>` +
    `<div class="ctx-item" data-a="rename">${ic(IC.pencil)}Rename…</div>` +
    `<div class="ctx-item" data-a="cover">${ic(IC.image)}Set cover…</div>` +
    (pl.image ? `<div class="ctx-item" data-a="uncover">${ic(IC.x)}Remove cover</div>` : "") +
    `<div class="ctx-item" data-a="follow">${ic(IC.repeat)}${fw ? "Unfollow" : "Follow…"}</div>` +
    `<div class="ctx-item" data-a="save">${ic(IC.save)}Save locally</div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-item ctx-danger" data-a="del">${ic(IC.trash)}Delete</div>`;
  placeCtx(menu, x, y);
  menu.querySelectorAll("[data-a]").forEach(it => it.addEventListener("click", async () => {
    const a = it.dataset.a;
    closeCtx();
    if (a === "open") openPlaylist(id);
    else if (a === "rename") {
      const name = await askText("Rename playlist", { value: pl.name, ok: "Rename" });
      if (name) { PL.renamePlaylist(id, name); renderPlaylists(); if (active.type === "playlist" && active.id === id) openPlaylist(id); }
    }
    else if (a === "cover") {
      try {
        const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Choose a cover image", filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] }] } });
        if (p) { PL.setImage(id, p); renderPlaylists(); if (active.type === "playlist" && active.id === id) openPlaylist(id); flash("Cover set"); }
      } catch (e) { console.error("[pl cover]", e); }
    }
    else if (a === "uncover") { PL.setImage(id, ""); renderPlaylists(); if (active.type === "playlist" && active.id === id) openPlaylist(id); flash("Cover removed"); }
    else if (a === "follow") { if (fw) unfollowPlaylist(id); else followPlaylistFlow(id); }
    else if (a === "save") downloadPlaylist(id);
    else if (a === "del") {
      if (await askConfirm("Delete this playlist?", `“${pl.name}” — its tracks stay in the library.`, "Delete")) {
        PL.deletePlaylist(id); renderPlaylists();
        if (active.type === "playlist" && active.id === id) showLibrary();
      }
    }
  }));
}

// Open a folder (or a file's containing folder) in the host file manager.
async function revealPath(path) {
  if (!IS_NATIVE) { flash("Available only in the app"); return; }
  if (!path) return;
  try { await invoke("open_path", { path }); }
  catch (e) { flash(`Could not open location: ${e}`); }
}
// Right-click menu for a source folder.
function openSourceCtx(x, y, folder) {
  const menu = $("#ctxMenu");
  menu.innerHTML =
    `<div class="ctx-item" data-a="open">${ic(IC.folder)}Open</div>` +
    `<div class="ctx-item" data-a="reveal">${ic(IC.folder)}Open folder location</div>` +
    `<div class="ctx-item" data-a="refresh">${ic(IC.refresh)}Check for new songs</div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-item ctx-danger" data-a="remove">${ic(IC.x)}Remove source</div>`;
  placeCtx(menu, x, y);
  menu.querySelectorAll("[data-a]").forEach(it => it.addEventListener("click", () => {
    const a = it.dataset.a;
    closeCtx();
    if (a === "open") openSource(folder);
    else if (a === "reveal") revealPath(folder);
    else if (a === "refresh") rescanFolder(folder);
    else if (a === "remove") removeSource(folder);
  }));
}

// ─── Sources (folders) ───
function renderSources() {
  const host = $("#sourcesList");
  if (!folders.length) { host.innerHTML = `<div class="src-empty">No folders yet — add one above.</div>`; return; }
  host.innerHTML = folders.map(f => {
    const count = library.filter(t => inFolder(t, f)).length;
    const on = active.type === "source" && active.id === f;
    return `<div class="src-row ${on ? "active" : ""}" data-src="${esc(f)}" title="${esc(f)}">
      <span class="src-ico" data-ic="folder"></span>
      <span class="src-name">${esc(baseName(f))}</span>
      <span class="src-count">${count}</span>
      <button class="src-btn" data-refresh="${esc(f)}" title="Check for new songs">${IC.refresh}</button>
      <button class="src-btn" data-remove="${esc(f)}" title="Remove source">${IC.x}</button>
    </div>`;
  }).join("");
  host.querySelectorAll("[data-src]").forEach(el => {
    el.addEventListener("click", (e) => { if (e.target.dataset.refresh !== undefined || e.target.dataset.remove !== undefined) return; openSource(el.dataset.src); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); openSourceCtx(e.clientX, e.clientY, el.dataset.src); });
  });
  host.querySelectorAll("[data-refresh]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); rescanFolder(b.dataset.refresh); }));
  host.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); removeSource(b.dataset.remove); }));
  $("#sideFilter")?.dispatchEvent(new Event("input")); // keep the filter applied
}

function openSource(folder) {
  active = { type: "source", id: folder };
  markActive();
  selected.clear();
  const tracks = library.filter(t => inFolder(t, folder));
  setViewHead({ icon: IC.folder, title: baseName(folder), subtitle: `${tracks.length} songs · ${folder}` });
  renderTracks(tracks);
}

// Differential refresh: the backend only reads tags of files we don't know yet
// (async command), so refreshing 1000+ known files is near-instant and the UI
// never freezes.
async function diffFolder(folder) {
  // Canonicalize the folder FIRST: rescans can be called with an alias (e.g. a
  // downloadDir that is a symlink twin of a source folder) — without this the
  // prune filter below compares the wrong prefix and freshly scanned files
  // come back under a second spelling.
  if (IS_NATIVE) { try { folder = await invoke("canon_path", { path: folder }); } catch {} }
  // Pass the WHOLE library as "known": if the folder spelling ever drifts from
  // the stored track paths (symlink alias), a folder-scoped set would come back
  // empty and every file would return as "new" — doubling the library.
  const known = library.map(t => t.path);
  const diff = await invoke("scan_diff", { paths: [folder], known }).catch(e => { console.error("[scan]", e); return null; });
  if (!diff) return 0;
  const present = new Set(diff.present || []);
  const have = new Set(known);
  const fresh = (diff.new_tracks || []).filter(t => !have.has(t.path)); // belt & braces
  // Keep tracks outside this folder + this folder's tracks that still exist, add new.
  library = library.filter(t => !inFolder(t, folder) || present.has(t.path)).concat(fresh);
  return fresh.length;
}
async function rescanFolder(folder) {
  flash(`Checking ${baseName(folder)}…`);
  const fresh = await diffFolder(folder);
  await saveLibrary();
  renderSources();
  if (active.type === "source" && active.id === folder) openSource(folder);
  else if (active.type === "library") showLibrary();
  flash(fresh ? `${fresh} new track${fresh === 1 ? "" : "s"} in ${baseName(folder)}` : `No new songs in ${baseName(folder)}`);
}

async function removeSource(folder) {
  if (!await askConfirm("Remove this source?", `${folder}\n\nIts tracks leave the library. The files on disk are NOT deleted.`, "Remove")) return;
  folders = folders.filter(f => f !== folder);
  library = library.filter(t => !inFolder(t, folder));
  saveLibrary();
  renderSources();
  showLibrary();
  flash("Source removed");
}

// ─── Playlists sidebar ───
// Fill a playlist cover element: the custom image if set, else the first track's
// artwork (online thumbnail or embedded local cover) as an auto mosaic-ish tile.
async function plCoverInto(el, pl) {
  if (!el || !pl) return;
  let url = "";
  if (pl.image) { try { url = await invoke("read_image", { path: pl.image }); } catch {} }
  if (!url && S().showArt) {
    for (const p of pl.paths.slice(0, 15)) {
      const t = trackByPath(p) || onlineIndex.get(p);
      if (t?.thumbnail) { url = t.thumbnail; break; }
      if (t && !isOnline(p)) { try { const c = await invoke("cover", { path: p }); if (c) { url = c; break; } } catch {} }
    }
  }
  if (url) { el.style.backgroundImage = `url("${String(url).replace(/"/g, "%22")}")`; el.classList.add("has-cover"); el.textContent = ""; }
}
function playlistTitles(pl, max = 25) {
  return pl.paths.slice(0, max).map(p => {
    const t = trackByPath(p) || onlineIndex.get(p);
    return (t && t.title) ? t.title : baseName(String(p));
  });
}
function closePreview() { $("#plPreview")?.remove(); }
// Quick peek at a playlist's tracks without opening it (the 👁 button).
function showPlaylistPreview(id, anchor) {
  closePreview();
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const titles = playlistTitles(pl);
  const box = document.createElement("div");
  box.id = "plPreview"; box.className = "pl-preview";
  box.innerHTML = `<div class="plp-head">${esc(pl.name)} · ${pl.paths.length} track${pl.paths.length === 1 ? "" : "s"}</div>` +
    (titles.length
      ? titles.map((t, i) => `<div class="plp-row"><span class="plp-n">${i + 1}</span> ${esc(t)}</div>`).join("")
      : `<div class="plp-empty">Empty playlist</div>`) +
    (pl.paths.length > titles.length ? `<div class="plp-more">… ${pl.paths.length - titles.length} more</div>` : "");
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.min(r.right + 8, window.innerWidth - box.offsetWidth - 8) + "px";
  box.style.top = Math.max(8, Math.min(r.top, window.innerHeight - box.offsetHeight - 8)) + "px";
  setTimeout(() => document.addEventListener("click", closePreview, { once: true }), 0);
}
function renderPlaylists() {
  const host = $("#playlistsList");
  const pls = PL.getPlaylists();
  host.innerHTML =
    `<div class="pl-row" id="plNew"><span class="row-ic">${IC.plus}</span> New playlist</div>` +
    pls.map(p => {
      const on = active.type === "playlist" && active.id === p.id;
      const fw = followFor(p.id);
      return `<div class="pl-row ${on ? "active" : ""}" data-pl="${p.id}"><span class="pl-cover" data-cover="${p.id}">${IC.note}</span> <span class="pl-name">${esc(p.name)}${fw ? ` <span class="pl-follow" title="Following “${esc(fw.title)}” — new tracks are added automatically">${IC.repeat}</span>` : ""}</span> <span class="pl-count">${p.paths.length}</span>
        <button class="pl-eye" data-eye="${p.id}" title="Preview tracks">${IC.eye}</button>
        <button class="pl-del" data-del="${p.id}" title="Delete">${IC.x}</button></div>`;
    }).join("");
  host.querySelector("#plNew").addEventListener("click", async () => { const name = await askText("New playlist", { placeholder: "Playlist name", ok: "Create" }); if (name !== null) { PL.createPlaylist(name); renderPlaylists(); } });
  host.querySelectorAll("[data-pl]").forEach(el => {
    el.addEventListener("click", (e) => { if (e.target.dataset.del !== undefined || e.target.dataset.eye !== undefined) return; openPlaylist(el.dataset.pl); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); openPlaylistCtx(e.clientX, e.clientY, el.dataset.pl); });
  });
  host.querySelectorAll("[data-eye]").forEach(btn => btn.addEventListener("click", (e) => { e.stopPropagation(); showPlaylistPreview(btn.dataset.eye, btn); }));
  host.querySelectorAll("[data-cover]").forEach(el => { const pl = pls.find(p => p.id === el.dataset.cover); plCoverInto(el, pl); });
  host.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async (e) => { e.stopPropagation(); if (await askConfirm("Delete this playlist?", "", "Delete")) { PL.deletePlaylist(btn.dataset.del); renderPlaylists(); } }));
  $("#sideFilter")?.dispatchEvent(new Event("input")); // keep the filter applied
}
function openPlaylist(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  active = { type: "playlist", id };
  markActive();
  const byPath = new Map(library.map(t => [t.path, t]));
  selected.clear();
  const nOnline = pl.paths.filter(isOnline).length;
  // Rows are limited to tracks that actually exist on disk. A path is hidden
  // only while it has no local file: downloading it (or its twin landing in the
  // library) makes it appear on the next render, with no edit to the playlist.
  // Nothing is removed — pl.paths is untouched, and "Save locally" still reaches
  // the hidden entries — so the subtitle states the count instead of letting
  // songs seem to vanish.
  const shownPaths = pl.paths.filter(p => !isStreamTrack(p));
  const nHidden = pl.paths.length - shownPaths.length;
  const fw = followFor(id);
  setViewHead({
    icon: IC.note, title: pl.name, subtitle: `${shownPaths.length} songs${nHidden ? ` · ${nHidden} not downloaded (hidden)` : ""}${fw ? ` · ↻ followed` : ""}`,
    actions:
      `<button id="plRefreshBtn" class="btn-line sm" title="Refresh titles, covers, and icons">${ic(IC.refresh)} Refresh</button>` +
      `<button id="plUrlBtn" class="btn-line sm" title="Add a YouTube video or playlist by URL">${ic(IC.link)} Add from URL</button>` +
      `<button id="plFollowBtn" class="btn-line sm" title="${fw ? esc(`Following “${fw.title}” — click to unfollow`) : "Watch the source playlist and auto-add its new tracks"}">${ic(IC.repeat)} ${fw ? "Following" : "Follow"}</button>` +
      (nOnline ? `<button id="plDlBtn" class="btn-line sm">${ic(IC.save)} Save locally (${nOnline} mp3)</button>` : "") +
      `<button id="plDupsBtn" class="btn-line sm" title="Check and remove duplicate songs">${ic(IC.filter)} Clean duplicates</button>`,
  });
  $("#plRefreshBtn")?.addEventListener("click", refreshActiveViewAction);
  $("#plUrlBtn")?.addEventListener("click", () => addByUrl(id));
  $("#plDlBtn")?.addEventListener("click", () => downloadPlaylist(id));
  $("#plFollowBtn")?.addEventListener("click", () => (followFor(id) ? unfollowPlaylist(id) : followPlaylistFlow(id)));
  $("#plDupsBtn")?.addEventListener("click", () => checkDuplicatesFlow("playlist", id));
  const vhIcon = $("#viewHead .vh-icon"); if (vhIcon) { vhIcon.classList.add("vh-cover"); plCoverInto(vhIcon, pl); }
  renderTracks(shownPaths.map(p => byPath.get(p) || ensureOnlineTrack(p)).filter(Boolean));
}

// Add a YouTube video OR playlist by URL straight into this playlist. yt_playlist
// returns one track for a video URL and many for a playlist URL, so both work.
async function addByUrl(plId) {
  if (!IS_NATIVE) { flash("Adding by URL needs the native app"); return; }
  const url = await askText("Add from URL", { placeholder: "YouTube video or playlist URL", ok: "Add" });
  if (!url) return;
  flash("Fetching…");
  try {
    const res = await invoke("yt_playlist", { url: url.trim() });
    const tracks = (res.tracks || []).map(onlineFromResult);
    if (!tracks.length) { flash("Nothing found at that URL"); return; }
    tracks.forEach(t => onlineIndex.set(t.path, t));
    let n = 0;
    for (const t of tracks) { const dup = PL.countExisting(plId, [t.path]); PL.addToPlaylist(plId, t.path); if (!dup) n++; }
    saveOnline();
    renderPlaylists();
    if (active.type === "playlist" && active.id === plId) openPlaylist(plId);
    flash(n ? `Added ${n} track${n === 1 ? "" : "s"}` : "Already in the playlist");
  } catch (e) { flash(`Could not add: ${e}`); }
}

// Follow an ALREADY-imported playlist: reuse its remembered source URL, or ask
// for one. Everything currently upstream or already in the playlist counts as
// known — only future additions will arrive.
async function followPlaylistFlow(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  let url = pl.sourceUrl || await askText("Follow a playlist", { placeholder: "YouTube playlist URL", ok: "Follow" });
  if (!url || !url.trim()) return;
  url = url.trim();
  flash("Linking playlist…");
  try {
    const res = await invoke("yt_playlist", { url });
    const upstream = (res.tracks || []).map(t => t.id);
    const local = pl.paths
      .map(p => (isOnline(p) ? ytId(p) : (String(p).match(/\[([A-Za-z0-9_-]{11})\]/) || [])[1]))
      .filter(Boolean);
    addFollow({ url, title: res.title || pl.name, playlistId: id, autoDownload: S().autoSaveImports, knownIds: [...upstream, ...local] });
    PL.setSourceUrl(id, url);
    renderPlaylists(); openPlaylist(id);
    flash(`Following “${res.title || pl.name}” — new tracks will be added automatically`);
  } catch (e) { flash(`Cannot follow: ${e}`); }
}
async function unfollowPlaylist(id) {
  const fw = followFor(id);
  if (!fw) return;
  if (!await askConfirm(`Unfollow “${fw.title}”?`, "Already-added tracks are kept.", "Unfollow")) return;
  follows = follows.filter(f => f.id !== fw.id);
  saveFollows(); renderPlaylists(); openPlaylist(id);
  flash("Unfollowed");
}

// ─── Import a playlist from another app ───
// A local/YouTube player can't read Spotify audio, but it can take a playlist's
// song list (title + artist) — from a public Spotify link (backend scrape) or a
// pasted "Artist - Title" list — match each track on YouTube, and collect them
// into a new local playlist (optionally downloaded to mp3).
function openImportPick() { toggleSidebar(false); $("#pickModal").hidden = false; }
let _extBusy = false, _extCancel = false;
function openExtImport() {
  if (!IS_NATIVE) { flash("Importing needs the native app"); return; }
  _extBusy = false; _extCancel = false;
  $("#extInput").value = ""; $("#extName").value = ""; $("#extDl").checked = S().autoSaveImports;
  extStatus(""); $("#extBar").hidden = true; $("#extBarFill").style.width = "0%";
  $("#extCancel").hidden = true; $("#extGo").disabled = false;
  $("#extModal").hidden = false; $("#extInput").focus();
}
function extStatus(msg, err) { const el = $("#extStatus"); el.textContent = msg; el.style.color = err ? "#f59e0b" : ""; }
function extDone() { _extBusy = false; $("#extGo").disabled = false; $("#extCancel").hidden = true; }
async function runExtImport() {
  if (_extBusy) return;
  const raw = $("#extInput").value.trim();
  if (!raw) { extStatus("Paste a Spotify link or a song list first.", true); return; }
  _extBusy = true; _extCancel = false;
  const name0 = $("#extName").value.trim();
  const dl = $("#extDl").checked;
  const sp = raw.match(/(?:https?:\/\/[^\s]*open\.spotify\.com\/[^\s]+|spotify:(?:playlist|album|track):[A-Za-z0-9]+)/);
  // Everything below runs in the background (Activity drawer): close the modal
  // right away so the user can keep using the app while tracks are matched.
  $("#extModal").hidden = true;
  flash("Import running in the background — watch the Activity badge");
  const tid = taskStart("Playlist import", { detail: sp ? "reading Spotify…" : "reading list…", pct: 0, cancel: () => { _extCancel = true; } });

  let name = name0;
  let jobs = []; // { q, dur } — dur (secs) picks the best YouTube hit when known
  try {
    if (sp) {
      const imp = await invoke("import_spotify", { url: sp[0] });
      if (!name) name = imp.name;
      jobs = (imp.tracks || [])
        .map(t => ({ q: `${t.artist} ${t.title}`.trim(), dur: Number(t.duration_secs) || 0 }))
        .filter(j => j.q);
    } else {
      // Pasted list: one song per line (drop stray URLs / blank lines).
      jobs = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^https?:\/\//.test(l)).map(q => ({ q, dur: 0 }));
    }
  } catch (e) { taskEnd(tid, { status: "error", detail: String(e) }); extDone(); return; }
  if (!jobs.length) { taskEnd(tid, { status: "error", detail: "nothing to import" }); extDone(); return; }

  const resolved = [], missed = [];
  for (let i = 0; i < jobs.length; i++) {
    if (_extCancel) break;
    const { q, dur } = jobs[i];
    taskUpdate(tid, { detail: `${i + 1}/${jobs.length} — ${q}`, pct: (i / jobs.length) * 100 });
    try {
      // Take the top few hits and prefer the one whose duration matches the
      // Spotify track — kills most "live version / sped up / 10h loop" misses.
      const res = await invoke("yt_search", { query: q, limit: dur ? 3 : 1, offset: 0 });
      const hits = Array.isArray(res) ? res : [];
      let hit = hits[0];
      if (dur && hits.length > 1) {
        const scored = hits.map(h => ({ h, d: Math.abs((Number(h.duration_secs) || 0) - dur) }));
        scored.sort((a, b) => a.d - b.d);
        if (scored[0].d <= 15) hit = scored[0].h; // close-enough duration wins
      }
      if (hit) resolved.push(onlineFromResult(hit)); else missed.push(q);
    } catch { missed.push(q); }
  }
  if (!resolved.length) { taskEnd(tid, { status: "error", detail: "no track matched on YouTube" }); extDone(); return; }

  resolved.forEach(t => onlineIndex.set(t.path, t));
  const pl = PL.createPlaylist(name || "Imported playlist");
  resolved.forEach(t => PL.addToPlaylist(pl.id, t.path));
  saveOnline(); renderPlaylists();
  if (dl) downloadTracks(resolved.map(t => t.path));
  extDone();
  taskEnd(tid, {
    detail: `${resolved.length} imported${missed.length ? ` · ${missed.length} not found` : ""}${_extCancel ? " (stopped)" : ""} — click to open`,
    onClick: () => openPlaylist(pl.id),
  });
  flash(`Imported ${resolved.length} track${resolved.length === 1 ? "" : "s"}${missed.length ? ` · ${missed.length} not found` : ""}${_extCancel ? " (stopped)" : ""}${dl ? " · downloading…" : ""}`);
}

// ─── YouTube search (Enter in the search bar) ───
let onlineResults = [];   // video results
let onlinePlaylists = []; // playlist results (shown when the Playlists filter is on)
let onlineQuery = "";
let ytPage = 0, ytHasMore = false;
// Artist/channel header card shown on the first page of a search.
let ytArtist = null, ytArtistMode = "videos", ytArtistPls = [];
// Phones default to the row list (readable 2-line titles, 40px covers — the
// box recipe that renders everywhere); desktop keeps the card grid. Separate
// keys so each device class remembers its own explicit toggle.
function ytViewMode() { return IS_TOUCH ? (S().ytViewTouch || "list") : (S().ytView || "grid"); }
function renderOnlineResults() {
  active = { type: "online", id: onlineQuery };
  markActive();
  const plMode = !!ytArtist && ytArtistMode === "playlists" && ytPage === 0;
  const wantVideos = S().ytIncludeVideos !== false;
  const wantPlaylists = S().ytIncludePlaylists !== false;
  const shown = plMode ? [] : (wantVideos ? onlineResults : []);
  // Tracks already saved locally sink to their own section at the bottom.
  const fresh = [], owned = [];
  if (!plMode) for (const t of shown) (libraryLocalFor(ytId(t.path)) ? owned : fresh).push(t);
  const pls = plMode ? [] : (wantPlaylists ? onlinePlaylists : []);
  setViewHead({
    icon: IC.globe, title: "YouTube",
    subtitle: plMode
      ? `Playlists of ${ytArtist.title} · ${ytArtistPls.length}`
      : `Page ${ytPage + 1} · ${shown.length} video${shown.length === 1 ? "" : "s"}` +
        (pls.length ? ` · ${pls.length} playlist${pls.length === 1 ? "" : "s"}` : "") +
        ` for “${onlineQuery}”` +
        (owned.length ? ` · ${owned.length} already in your library` : ""),
    actions: plMode ? "" :
      `<div class="yt-viewtog">
        <button id="ytGridBtn" class="btn-line sm ${ytViewMode() === "grid" ? "ac-on" : ""}" title="Card view (mini YouTube)">▦</button>
        <button id="ytListBtn" class="btn-line sm ${ytViewMode() === "list" ? "ac-on" : ""}" title="List view">≡</button>
      </div>` +
      `<label class="yt-inc"><input type="checkbox" id="ytIncVid" ${wantVideos ? "checked" : ""}> Videos</label>` +
      `<label class="yt-inc"><input type="checkbox" id="ytIncPl" ${wantPlaylists ? "checked" : ""}> Playlists</label>` +
      `<button id="ytPrev" class="btn-line sm" ${ytPage ? "" : "disabled"}>‹ Prev</button>` +
      `<button id="ytNext" class="btn-line sm" ${ytHasMore ? "" : "disabled"}>Next ›</button>`,
  });
  $("#ytIncVid")?.addEventListener("change", e => {
    SETTINGS.setSetting("ytIncludeVideos", e.target.checked);
    // Fetch videos lazily if they were toggled on and we never got them.
    if (e.target.checked && !onlineResults.length) searchOnline(onlineQuery, ytPage);
    else renderOnlineResults();
  });
  $("#ytIncPl")?.addEventListener("change", e => {
    SETTINGS.setSetting("ytIncludePlaylists", e.target.checked);
    if (e.target.checked && !onlinePlaylists.length) searchOnline(onlineQuery, ytPage);
    else renderOnlineResults();
  });
  $("#ytPrev")?.addEventListener("click", () => searchOnline(onlineQuery, ytPage - 1));
  $("#ytNext")?.addEventListener("click", () => searchOnline(onlineQuery, ytPage + 1));
  $("#ytGridBtn")?.addEventListener("click", () => { SETTINGS.setSetting(IS_TOUCH ? "ytViewTouch" : "ytView", "grid"); renderOnlineResults(); });
  $("#ytListBtn")?.addEventListener("click", () => { SETTINGS.setSetting(IS_TOUCH ? "ytViewTouch" : "ytView", "list"); renderOnlineResults(); });
  if (plMode) {
    renderArtistPlaylists();
  } else if (ytViewMode() === "grid") {
    renderYtGrid(sortTracks([...fresh]), sortTracks([...owned]), pls);
  } else {
    renderTracks([...sortTracks([...fresh]), ...sortTracks([...owned])], true);
    if (owned.length) {
      const host = $("#trackList");
      const firstOwned = host.querySelector(`.track[data-idx="${fresh.length}"]`);
      if (firstOwned) firstOwned.insertAdjacentHTML("beforebegin", `<div class="list-sep">${IC.check} Already in your library</div>`);
      for (let i = fresh.length; i < view.length; i++) host.querySelector(`.track[data-idx="${i}"]`)?.classList.add("owned");
    }
    if (pls.length) prependPlaylistList(pls); // list view: playlists as rows on top
    // The "# TITLE ALBUM ⏱" columns belong to the local library table — they
    // don't line up with (or apply to) YouTube results and playlist cards.
    showListChrome(false);
  }
  injectArtistCard();
}
// A row of playlist cards (thumbnail + title + author + count) shown above the
// video results; clicking one opens the playlist detail window.
function playlistCardHtml(p, i) {
  const cnt = p.count ? `${p.count} track${p.count === 1 ? "" : "s"}` : "playlist";
  return `<div class="pl-card" data-plhit="${i}" title="${esc(p.title)}">
    <div class="pc-thumb"${p.thumbnail ? ` style="background-image:url('${esc(p.thumbnail)}')"` : ""}><span class="pc-badge">${IC.list}</span></div>
    <div class="pc-meta"><div class="pc-title">${esc(p.title)}</div><div class="pc-sub">${esc(p.author || "YouTube")} · ${cnt}</div></div>
  </div>`;
}
function wirePlaylistCards(root, pls) {
  root.querySelectorAll("[data-plhit]").forEach(el =>
    el.addEventListener("click", () => openPlaylistDetail(pls[Number(el.dataset.plhit)])));
}
function prependPlaylistList(pls) {
  const host = $("#trackList");
  const wrap = document.createElement("div");
  wrap.className = "pl-card-row";
  wrap.innerHTML = `<div class="list-sep">${IC.list} Playlists (${pls.length})</div>` + pls.map(playlistCardHtml).join("")
    + (view.length ? `<div class="list-sep">${IC.music} Songs (${view.length})</div>` : "");
  host.insertAdjacentElement("afterbegin", wrap);
  wirePlaylistCards(wrap, pls);
  proxyCovers(wrap);
}
// WebKitGTK (desktop) and some WebViews pass @supports(aspect-ratio) yet lay
// out stretch-sized flex children at 0 height → video covers (and the duration
// badge inside them) silently vanish while the playlists' fixed-size boxes
// keep painting. Pin every thumb to a measured pixel height instead — the
// fixed-size box is the one recipe that renders on every engine we've met.
function fixThumbHeights(root) {
  (root || document).querySelectorAll(".yc-thumb").forEach(el => {
    const w = el.clientWidth;
    if (w) el.style.height = Math.round(w * 9 / 16) + "px";
  });
}
// ─── Wheel smoothing ───
// WebKitGTK applies wheel deltas as hard jumps ("it teleports then glides").
// Ease the scroll position toward an accumulated target with rAF instead.
// Touch devices keep native momentum; reduced-motion users keep raw jumps.
function smoothWheel(el) {
  if (!el || IS_TOUCH || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let target = 0, raf = 0;
  el.addEventListener("wheel", e => {
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
    target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, (raf ? target : el.scrollTop) + step));
    if (!raf) tick();
  }, { passive: false });
  function tick() {
    const cur = el.scrollTop, d = target - cur;
    if (Math.abs(d) < 1) { el.scrollTop = target; raf = 0; return; }
    el.scrollTop = cur + d * 0.24;
    raf = requestAnimationFrame(tick);
  }
}
let _thumbRz = 0;
window.addEventListener("resize", () => {
  clearTimeout(_thumbRz);
  _thumbRz = setTimeout(() => {
    const host = $("#trackList");
    if (host && host.classList.contains("yt-grid")) fixThumbHeights(host);
  }, 120);
});
// Mini-YouTube card grid: 16:9 thumbnail + duration badge + channel + views,
// hover ▶ plays instantly. Cards keep the .track class + data-path/data-idx so
// the existing delegation (select, double-click, context menu) works untouched.
let _gridSeq = 0;
async function renderYtGrid(fresh, owned, playlists = []) {
  view = [...fresh, ...owned];
  updateCount();
  const host = $("#trackList");
  showListChrome(false);
  host.classList.add("yt-grid");
  if (!view.length && !playlists.length) { host.innerHTML = `<div class="empty"><div class="empty-ico">${IC.music}</div>No results.</div>`; return; }
  // The results should appear COMPLETE: preload every cover into the proxy
  // cache behind a percent bar, then inject the finished grid in one go.
  const seq = ++_gridSeq;
  const urls = IS_NATIVE ? [...new Set([...playlists.map(p => p.thumbnail), ...view.map(t => t.thumbnail)].filter(Boolean))] : [];
  if (urls.length) {
    let done = 0;
    host.innerHTML = `<div class="yt-loading"><div class="yt-prog"><div class="yt-prog-fill" id="ytProgFill"></div></div><div class="yt-prog-txt" id="ytProgTxt">Loading covers… 0%</div></div>`;
    await Promise.all(urls.map(u => netThumb(u).catch(() => {}).then(() => {
      done++;
      if (seq !== _gridSeq) return;
      const pct = Math.round(done / urls.length * 100);
      const f = $("#ytProgFill"), t = $("#ytProgTxt");
      if (f) f.style.width = pct + "%";
      if (t) t.textContent = `Loading covers… ${pct}%`;
    })));
    if (seq !== _gridSeq) return; // a newer search/render took over meanwhile
  }
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  const card = (t, i, own) => {
    const vs = fmtViews(t.views);
    return `<div class="track yt-card ${nowPath === t.path ? "playing" : ""} ${own ? "owned" : ""} ${selected.has(t.path) ? "selected" : ""}" data-path="${esc(t.path)}" data-idx="${i}">
      <div class="yc-thumb"${t.thumbnail ? ` style="background-image:url('${esc(t.thumbnail)}')"` : ""}>
        <span class="yc-dur">${fmtDur(t.duration_secs)}</span>
        ${own ? `<span class="yc-own" title="Already in your library">${IC.check}</span>` : ""}
        <button class="yc-play" data-play="${i}" title="Play now">${IC.play}</button>
      </div>
      <div class="yc-meta">
        <div class="yc-title" title="${esc(t.title)}">${esc(t.title)}</div>
        <div class="yc-sub">${esc(t.artist)}${vs ? ` · ${vs}` : ""}</div>
      </div>
      <button class="more yc-more" title="More" data-more="${i}">⋯</button>
    </div>`;
  };
  const plHtml = playlists.length
    ? `<div class="list-sep">${IC.list} Playlists (${playlists.length})</div>` + `<div class="pl-card-grid">` + playlists.map(playlistCardHtml).join("") + `</div>`
    : "";
  // An explicit "Songs" header whenever both kinds are on screen — without it
  // the playlist cards and the video cards read as one continuous blob.
  const songSep = playlists.length && (fresh.length || owned.length)
    ? `<div class="list-sep">${IC.music} Songs (${fresh.length + owned.length})</div>`
    : "";
  host.innerHTML =
    plHtml + songSep +
    fresh.map((t, i) => card(t, i, false)).join("") +
    (owned.length
      ? `<div class="list-sep">${IC.check} Already in your library</div>` + owned.map((t, i) => card(t, fresh.length + i, true)).join("")
      : "");
  if (playlists.length) wirePlaylistCards(host, playlists);
  updatePlayingRow();
  proxyCovers(host);
  fixThumbHeights(host);
}
// The channel header (avatar, name, mode toggle, "Download all"), pinned above
// the results on page 1 once yt_channel resolves.
function injectArtistCard() {
  if (!ytArtist || ytPage !== 0) return;
  const a = ytArtist;
  const card = document.createElement("div");
  card.className = "artist-card";
  card.innerHTML =
    `<div class="ac-avatar"${a.thumbnail ? ` style="background-image:url('${esc(a.thumbnail)}')"` : ""}></div>
     <div class="ac-meta"><div class="ac-name">${esc(a.title)}</div><div class="ac-sub">YouTube channel</div></div>
     <div class="ac-actions">
       <button class="btn-line sm ${ytArtistMode === "videos" ? "ac-on" : ""}" data-ac="videos">${ic(IC.play)}Videos</button>
       <button class="btn-line sm ${ytArtistMode === "playlists" ? "ac-on" : ""}" data-ac="playlists">${ic(IC.list)}Playlists</button>
       <button class="btn-line sm" data-ac="dl">${ic(IC.upload)}Download all</button>
     </div>`;
  $("#trackList").insertAdjacentElement("afterbegin", card);
  card.querySelector('[data-ac="videos"]').addEventListener("click", () => { if (ytArtistMode !== "videos") { ytArtistMode = "videos"; renderOnlineResults(); } });
  card.querySelector('[data-ac="playlists"]').addEventListener("click", loadArtistPlaylists);
  card.querySelector('[data-ac="dl"]').addEventListener("click", downloadArtistAll);
  proxyCovers(card);
}
function renderArtistPlaylists() {
  const host = $("#trackList");
  host.classList.remove("yt-grid");
  showListChrome(false);
  host.innerHTML = ytArtistPls.length
    ? ytArtistPls.map((p, i) => `<div class="ac-pl" data-acpl="${i}" title="${esc(p.url)}"><span class="ac-pl-t">${esc(p.title)}</span><span class="ac-pl-a">${esc(p.author || "")}</span></div>`).join("")
    : `<div class="empty"><div class="empty-ico">${IC.music}</div>No public playlists on this channel.</div>`;
  host.querySelectorAll("[data-acpl]").forEach(el => el.addEventListener("click", () => importChannelPlaylist(ytArtistPls[Number(el.dataset.acpl)].url)));
}
async function loadArtistPlaylists() {
  if (!ytArtist) return;
  ytArtistMode = "playlists";
  const host = $("#trackList");
  host.innerHTML = `<div class="empty"><div class="empty-ico">${IC.radio}</div>Loading playlists…</div>`;
  injectArtistCard();
  try {
    ytArtistPls = await invoke("yt_channel_playlists", { url: ytArtist.url, limit: 40, offset: 0 });
    renderOnlineResults();
  } catch (e) {
    host.innerHTML = `<div class="empty"><div class="empty-ico">${IC.alert}</div>${esc(String(e))}</div>`;
    injectArtistCard();
  }
}
// Preview/import one of the channel's playlists via the existing import modal.
function importChannelPlaylist(url) {
  openImport();
  $("#impUrl").value = url;
  impFetch();
}
async function downloadArtistAll() {
  if (!ytArtist) return;
  const tid = taskStart(`Listing ${ytArtist.title}`, { detail: "fetching the full track list…" });
  let all;
  try { all = await invoke("yt_channel_all", { url: ytArtist.url }); }
  catch (e) { taskEnd(tid, { status: "error", detail: String(e) }); flash(`Could not list tracks: ${e}`); return; }
  if (!all?.length) { taskEnd(tid, { status: "error", detail: "no videos found" }); flash("No videos found on this channel"); return; }
  taskEnd(tid, { detail: `${all.length} tracks listed`, ttl: 4000 });
  if (!await askConfirm(`Download everything from ${ytArtist.title}?`, `${all.length} track${all.length === 1 ? "" : "s"} will be queued as mp3 (already-downloaded ones are skipped).`, `Download ${all.length}`)) return;
  const tracks = all.map(onlineFromResult);
  tracks.forEach(t => onlineIndex.set(t.path, t));
  saveOnline();
  downloadTracks(tracks.map(t => t.path));
}
let _searchSeq = 0;
async function searchOnline(q, page = 0) {
  if (!q) return;
  if (!IS_NATIVE) { flash("YouTube search needs the native app"); return; }
  const seq = ++_searchSeq; // newest search wins; stale responses are dropped
  onlineQuery = q;
  ytPage = Math.max(0, page);
  if (ytPage === 0) { ytArtist = null; ytArtistMode = "videos"; ytArtistPls = []; }
  active = { type: "online", id: q };
  markActive();
  selected.clear();
  setViewHead({ icon: IC.globe, title: "YouTube", subtitle: `Searching “${q}” — page ${ytPage + 1}… (you can keep browsing)` });
  showListChrome(false);
  $("#trackList").classList.remove("yt-grid");
  $("#trackList").innerHTML = `<div class="empty"><div class="empty-ico">${IC.radio}</div>Searching YouTube… Feel free to browse — the result lands in the Activity badge.</div>`;
  const tid = taskStart(`Search “${q}”`, { detail: `page ${ytPage + 1}` });
  try {
    const limit = Number(S().searchLimit) || 20;
    const wantVideos = S().ytIncludeVideos !== false;
    const wantPlaylists = S().ytIncludePlaylists !== false;
    // Fire both in parallel but DON'T let the (slower, natively-scraped)
    // playlist lookup hold back the video results — render the videos the moment
    // they land, then slot the playlists in when they arrive. Waiting on both
    // was what made search feel "way too long".
    const plP = wantPlaylists
      ? invoke("yt_search_playlists", { query: q, limit: Math.min(12, limit), offset: ytPage * Math.min(12, limit) }).catch(() => [])
      : Promise.resolve([]);
    const res = wantVideos ? await invoke("yt_search", { query: q, limit, offset: ytPage * limit }) : [];
    if (seq !== _searchSeq) { taskDrop(tid); return; } // superseded by a newer search
    ytHasMore = Array.isArray(res) && res.length >= limit;
    onlineResults = (res || []).map(onlineFromResult);
    onlinePlaylists = []; // filled in below when plP resolves
    onlineResults.forEach(t => onlineIndex.set(t.path, t));
    // Don't clobber wherever the user navigated meanwhile: render only if the
    // online view is still current, otherwise park the result in Activity.
    if (active.type === "online" && active.id === q) {
      renderOnlineResults();
      taskEnd(tid, { detail: `${onlineResults.length} results`, ttl: 5000 });
    } else {
      taskEnd(tid, {
        detail: `${onlineResults.length} results — click to view`,
        onClick: () => { onlineQuery = q; active = { type: "online", id: q }; renderOnlineResults(); },
      });
      flash(`Search “${q}” ready — see the Activity badge`);
    }
    // Playlists arrive independently → merge them in without blocking the videos.
    plP.then(pls => {
      if (seq !== _searchSeq) return;
      onlinePlaylists = Array.isArray(pls) ? pls : [];
      if (onlinePlaylists.length && active.type === "online" && onlineQuery === q) renderOnlineResults();
    });
  } catch (e) {
    if (seq !== _searchSeq) { taskDrop(tid); return; }
    taskEnd(tid, { status: "error", detail: String(e) });
    if (active.type === "online" && active.id === q) {
      setViewHead({ icon: IC.globe, title: "YouTube", subtitle: "Search failed" });
      $("#trackList").innerHTML = `<div class="empty"><div class="empty-ico">${IC.alert}</div>${esc(String(e))}</div>`;
    }
  }
  // Resolve the artist card in the background (first page only).
  if (ytPage === 0) {
    invoke("yt_channel", { query: q }).then(ch => {
      if (ch && seq === _searchSeq && active.type === "online" && onlineQuery === q) { ytArtist = ch; if (ytArtistMode === "videos") renderOnlineResults(); }
    }).catch(() => {});
  }
}

// ─── Account & cloud sync (Google Drive appDataFolder) ──────────────────
// Sign in with a Google account; playlists / settings / blocked / follows /
// online index sync through the private appDataFolder of THAT account's Drive,
// so the same account on any device shares the same library structure. Audio
// files are NOT synced (too big) — the local scan + LAN share bring those.
const SYNC_DEVICE_KEYS = new Set([ // never overwritten from the cloud (per-device)
  "downloadDir", "sideW", "npW", "ytdlpPath", "cookiesBrowser", "gdriveTokens",
  "gdriveClientId", "gdriveClientSecret", "startOnBoot", "uiScale", "syncAt",
]);
function gdriveCreds() { return { clientId: S().gdriveClientId || "", clientSecret: S().gdriveClientSecret || "" }; }
async function gdriveRestore() {
  const t = S().gdriveTokens;
  if (IS_NATIVE && t && t.refresh_token) { try { await invoke("gdrive_set_tokens", { tokens: t }); } catch {} }
}
async function accountSignIn() {
  if (!IS_NATIVE) { flash("Sign-in needs the native app"); return; }
  const { clientId, clientSecret } = gdriveCreds();
  if (!clientId) { flash("Enter your Google OAuth Client ID first (see the hint)"); return; }
  flash("Opening Google sign-in in your browser…");
  try {
    const res = await invoke("gdrive_sign_in", { clientId, clientSecret });
    SETTINGS.setSetting("gdriveTokens", res.tokens);
    flash(`Signed in as ${res.email || "Google account"}`);
    openSettings();
    await syncPull(true); // first thing: pull anything already in the cloud
  } catch (e) { flash(`Sign-in failed: ${e}`); }
}
async function accountSignOut() {
  try { await invoke("gdrive_sign_out"); } catch {}
  SETTINGS.setSetting("gdriveTokens", null);
  flash("Signed out"); openSettings();
}
// Build the sync bundle from the local stores.
function buildSyncBundle() {
  const s = S();
  const syncSettings = {};
  for (const [k, v] of Object.entries(s)) if (!SYNC_DEVICE_KEYS.has(k)) syncSettings[k] = v;
  return {
    v: 1, at: Date.now(),
    playlists: PL.getPlaylists(),
    settings: syncSettings,
    blocked: [...blockedKeys],
    follows,
    online: Object.fromEntries([...onlineIndex.entries()].slice(-4000)),
  };
}
// Merge a pulled bundle into local state (additive + newest-wins for settings).
function mergeSyncBundle(b) {
  if (!b || typeof b !== "object") return false;
  let changed = false;
  // Playlists: union by id; union track paths (dedup, keep order).
  if (Array.isArray(b.playlists)) {
    const mine = PL.getPlaylists();
    const byId = new Map(mine.map(p => [p.id, p]));
    for (const rp of b.playlists) {
      const cur = byId.get(rp.id);
      if (!cur) { PL.getPlaylists().push(rp); changed = true; }
      else {
        const seen = new Set(cur.paths);
        for (const p of (rp.paths || [])) if (!seen.has(p)) { cur.paths.push(p); seen.add(p); changed = true; }
        if (rp.name && rp.name !== cur.name) { cur.name = rp.name; changed = true; }
        if (rp.image && !cur.image) { cur.image = rp.image; changed = true; }
      }
    }
    if (changed) PL.persist();
  }
  // Online index: fill gaps (metadata for shared/streamed tracks).
  if (b.online) { for (const [k, v] of Object.entries(b.online)) if (!onlineIndex.has(k)) { onlineIndex.set(k, v); changed = true; } saveOnline(); }
  // Blocked: union.
  if (Array.isArray(b.blocked)) { const before = blockedKeys.size; for (const k of b.blocked) blockedKeys.add(k); if (blockedKeys.size !== before) { saveBlocked(); changed = true; } }
  // Follows: union by url.
  if (Array.isArray(b.follows)) { const urls = new Set(follows.map(f => f.url)); for (const f of b.follows) if (!urls.has(f.url)) { follows.push(f); changed = true; } if (changed) saveFollows(); }
  // Settings: apply cloud values (skipping device-specific keys) only if the
  // cloud bundle is newer than our last local change of settings.
  if (b.settings && typeof b.settings === "object") {
    for (const [k, v] of Object.entries(b.settings)) if (!SYNC_DEVICE_KEYS.has(k) && S()[k] !== v) { SETTINGS.setSetting(k, v); changed = true; }
  }
  return changed;
}
let _syncing = false;
async function syncPush(silent) {
  if (!IS_NATIVE || _syncing || !S().gdriveTokens?.refresh_token) return;
  _syncing = true;
  try {
    await invoke("gdrive_push", { ...gdriveCreds(), bundle: JSON.stringify(buildSyncBundle()) });
    SETTINGS.setSetting("syncAt", Date.now());
    if (!silent) flash("Synced to your Google Drive");
  } catch (e) { if (!silent) flash(`Sync (upload) failed: ${e}`); }
  finally { _syncing = false; }
}
async function syncPull(silent) {
  if (!IS_NATIVE || _syncing || !S().gdriveTokens?.refresh_token) return;
  _syncing = true;
  try {
    const raw = await invoke("gdrive_pull", { ...gdriveCreds() });
    if (raw) {
      const changed = mergeSyncBundle(JSON.parse(raw));
      if (changed) { renderPlaylists(); applySettings(); refreshView(); }
      if (!silent) flash(changed ? "Pulled updates from your Drive" : "Already up to date");
    } else if (!silent) flash("Nothing in the cloud yet — press Sync to upload");
    SETTINGS.setSetting("syncAt", Date.now());
  } catch (e) { if (!silent) flash(`Sync (download) failed: ${e}`); }
  finally { _syncing = false; }
}
async function syncNow() { await syncPull(true); await syncPush(false); }

// ─── Share over WiFi (LAN host ↔ client) ────────────────────────────────
// One device hosts its library over HTTP on the LAN; another connects with the
// host IP + a pairing code and streams / downloads. No account, no cloud.
let _remote = null; // { base, code, tracks: Map<path,track> } when connected
function shareKeyOf(t) {
  // Stable per-file key the host serves under (videoId or a path hash).
  const v = videoIdOf(t.path);
  if (v) return "v" + v;
  let h = 0; for (const c of t.path) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return "h" + h.toString(36);
}
function openShare() {
  toggleSidebar(false);
  $("#shareModal").hidden = false;
  refreshShareHost();
}
async function refreshShareHost() {
  try {
    const st = await invoke("share_status");
    $("#shareHostIdle").hidden = st.running;
    $("#shareHostOn").hidden = !st.running;
    if (st.running) {
      $("#shareAddr").textContent = `${st.ip} : ${st.port}`;
      $("#shareCode").textContent = st.code;
      $("#shareHostPort").value = st.port;
      $("#shareHostIp").value = $("#shareHostIp").value || st.ip;
    }
  } catch {}
}
async function shareHostStart() {
  if (!IS_NATIVE) { flash("Sharing needs the native app"); return; }
  // Only local files can be served (streams have no bytes to hand out).
  const local = library.filter(t => !isOnline(t.path));
  const files = local.map(t => ({ key: shareKeyOf(t), path: t.path }));
  const libExport = local.map(t => ({ ...t, _key: shareKeyOf(t) }));
  const btn = $("#shareHostStart"); btn.disabled = true; btn.textContent = "Starting…";
  try {
    const st = await invoke("share_start", {
      library: JSON.stringify(libExport),
      playlists: JSON.stringify(PL.getPlaylists()),
      files,
    });
    $("#shareHostInfo").textContent = `Sharing ${files.length} local track${files.length === 1 ? "" : "s"} + ${PL.getPlaylists().length} playlist${PL.getPlaylists().length === 1 ? "" : "s"}. Keep the app open.`;
    await refreshShareHost();
    flash(`Sharing on ${st.ip}:${st.port} — code ${st.code}`);
    const he = $("#shareHostErr"); if (he) { he.hidden = true; he.textContent = ""; }
  } catch (e) {
    const he = $("#shareHostErr");
    if (he) { he.hidden = false; he.textContent = `Could not start sharing: ${e}`; }
    flash(`Could not start sharing: ${e}`);
  }
  finally { btn.disabled = false; btn.textContent = "Start sharing"; }
}
async function shareHostStop() { try { await invoke("share_stop"); } catch {} refreshShareHost(); flash("Stopped sharing"); }
// Save a currently-streaming remote track to the local library (once).
const _remoteSaving = new Set();
async function shareSaveRemote(t) {
  if (!t?._remoteUrl || _remoteSaving.has(t.path)) return;
  const local = libraryLocalFor(videoIdOf(t.path));
  if (local) return; // already have it
  _remoteSaving.add(t.path);
  const vid = videoIdOf(t.path);
  const base = `${(t.artist || "Unknown").replace(/[\\/:*?"<>|]/g, "_")} - ${(t.title || "track").replace(/[\\/:*?"<>|]/g, "_")}`;
  const name = vid ? `${base} [${vid}].mp3` : `${base}.mp3`;
  const tid = taskStart("Saving from device", { detail: t.title || name });
  try {
    const file = await invoke("share_download", { url: t._remoteUrl, dir: S().downloadDir || "", name, id: vid || t.path });
    const dir = file.slice(0, file.lastIndexOf("/"));
    if (!folders.includes(dir)) folders.push(dir);
    await rescanFolder(dir);
    taskEnd(tid, { detail: "saved", ttl: 4000 });
  } catch (e) { taskEnd(tid, { status: "error", detail: String(e) }); }
  finally { _remoteSaving.delete(t.path); }
}
async function shareConnect() {
  if (!IS_NATIVE) { flash("Connecting needs the native app"); return; }
  // Smart input: the host shows "192.168.1.23 : 38291" — accept that whole
  // string (with or without spaces) pasted into the address field and split
  // out the port automatically; the code keeps digits only.
  let host = $("#shareHostIp").value.trim().replace(/\s+/g, "");
  let port = Number($("#shareHostPort").value) || 0;
  const hp = host.match(/^(.+?):(\d{2,5})$/);
  if (hp) { host = hp[1]; port = Number(hp[2]); $("#shareHostIp").value = host; $("#shareHostPort").value = port; }
  const code = $("#shareConnCode").value.trim().replace(/\D/g, "");
  if (!host) { $("#shareConnStatus").textContent = "Enter the host address shown on the other device."; return; }
  if (!port) { $("#shareConnStatus").textContent = "Enter the port (the number after the “:” on the host)."; return; }
  if (code.length !== 6) { $("#shareConnStatus").textContent = "Enter the 6-digit code shown on the host."; return; }
  const btn = $("#shareConnect"); btn.disabled = true; btn.textContent = "Connecting…";
  $("#shareConnStatus").textContent = "Connecting…";
  try {
    const data = await invoke("share_connect", { host, port, code });
    const remoteTracks = JSON.parse(data.library || "[]");
    const map = new Map();
    const tracks = remoteTracks.map(t => {
      const key = t._key || shareKeyOf(t);
      const streamUrl = `${data.base}/file/${key}?code=${encodeURIComponent(code)}`;
      // Give the remote track a distinct path so it doesn't collide with local.
      const rt = { ...t, path: "remote:" + key, _remoteUrl: streamUrl, _remoteKey: key, album: t.album || "Shared" };
      map.set(rt.path, rt); onlineIndex.set(rt.path, rt); return rt;
    });
    _remote = { base: data.base, code, tracks: map, saveLocal: $("#shareSaveLocal").checked };
    $("#shareModal").hidden = true;
    // Show the remote library as the current view.
    active = { type: "remote", id: host };
    markActive();
    setViewHead({ icon: IC.globe, title: `Shared from ${host}`, subtitle: `${tracks.length} track${tracks.length === 1 ? "" : "s"} streamed over WiFi` });
    $("#trackList").classList.remove("yt-grid");
    renderTracks(tracks, true);
    flash(`Connected — ${tracks.length} tracks`);
  } catch (e) {
    $("#shareConnStatus").textContent = String(e);
  } finally { btn.disabled = false; btn.textContent = "Connect"; }
}

// ─── Playlist detail window ─────────────────────────────────────────────
// A real preview (not a text blurb): the first N tracks (N = playlistPreviewCount
// setting) with thumbnails, an "Import" button, and a link to the full playlist
// on YouTube. Opened from a playlist search-result card.
let _plDetail = null;
async function openPlaylistDetail(p) {
  if (!p) return;
  _plDetail = p;
  const m = $("#plDetailModal");
  $("#plDetailTitle").textContent = p.title || "Playlist";
  $("#plDetailSub").textContent = `${p.author || "YouTube"}${p.count ? ` · ${p.count} track${p.count === 1 ? "" : "s"}` : ""}`;
  $("#plDetailLink").href = p.url;
  const cover = $("#plDetailCover");
  cover.style.backgroundImage = p.thumbnail ? `url("${p.thumbnail}")` : "";
  cover.classList.toggle("has-cover", !!p.thumbnail);
  proxyCovers(m);
  const cap = Math.max(1, Math.min(200, Number(S().playlistPreviewCount) || 25));
  $("#plDetailList").innerHTML = `<div class="nx-note">Loading first ${cap} tracks…</div>`;
  m.hidden = false;
  if (!IS_NATIVE) { $("#plDetailList").innerHTML = `<div class="nx-note">Preview needs the native app.</div>`; return; }
  try {
    const head = await invoke("yt_playlist_head", { url: p.url, count: cap });
    const tracks = (head.tracks || []).map(onlineFromResult);
    tracks.forEach(t => onlineIndex.set(t.path, t));
    _plDetail.previewTracks = tracks;
    if (!tracks.length) { $("#plDetailList").innerHTML = `<div class="nx-note">No tracks found.</div>`; return; }
    const more = p.count && p.count > tracks.length ? p.count - tracks.length : 0;
    $("#plDetailList").innerHTML = tracks.map(t =>
      `<div class="pd-row" data-pdplay="${esc(t.path)}">
        <div class="pd-thumb"${t.thumbnail ? ` style="background-image:url('${esc(t.thumbnail)}')"` : ""}></div>
        <div class="pd-meta"><div class="pd-t">${esc(t.title)}</div><div class="pd-s">${esc(t.artist)}${t.duration_secs ? " · " + fmtDur(t.duration_secs) : ""}</div></div>
      </div>`).join("") +
      (more ? `<a class="pd-more" href="${esc(p.url)}" target="_blank" rel="noopener">+ ${more} more — view the full playlist on YouTube ↗</a>` : "");
    $("#plDetailList").querySelectorAll("[data-pdplay]").forEach(el =>
      el.addEventListener("click", () => { const t = onlineIndex.get(el.dataset.pdplay); if (t) { queue = [t.path]; playFrom(0); } }));
    proxyCovers(m);
  } catch (e) {
    $("#plDetailList").innerHTML = `<div class="nx-note">Could not load: ${esc(String(e))}</div>`;
  }
}
function closePlaylistDetail() { $("#plDetailModal").hidden = true; _plDetail = null; }
async function importPlaylistDetail(save) {
  if (!_plDetail) return;
  const p = _plDetail;
  closePlaylistDetail();
  // Reuse the URL import flow (fetches the FULL playlist, respects follow/dl).
  openImport();
  $("#impUrl").value = p.url;
  await impFetch();
}

// ─── Playlist import from an external URL ───
let impTracks = [];
function openImport() {
  impTracks = [];
  impHits = []; impSearchQuery = ""; impSearchOffset = 0; impSearchMore = false; impPreviewRun++;
  $("#impQuery").value = ""; $("#impHits").innerHTML = "";
  $("#impUrl").value = ""; $("#impStatus").textContent = ""; $("#impList").innerHTML = "";
  $("#impDl").checked = S().autoSaveImports;
  $("#impFoot").hidden = true; $("#importModal").hidden = false;
  $("#impQuery").focus();
}
// Search YouTube for playlists by name/author; picking a hit fetches its tracks.
// Results accumulate: "Load more" fetches the next page via the offset param.
let impHits = [], impSearchQuery = "", impSearchOffset = 0, impSearchMore = false, impPreviewRun = 0;
async function impSearchGo(more = false) {
  const q = more ? impSearchQuery : $("#impQuery").value.trim();
  if (!q) return;
  if (!IS_NATIVE) { flash("Playlist search needs the native app"); return; }
  const host = $("#impHits");
  const limit = Number(S().searchLimit) || 20;
  if (!more) { impSearchQuery = q; impSearchOffset = 0; impHits = []; impPreviewRun++; host.innerHTML = `<div class="nx-note">Searching playlists…</div>`; }
  else { const b = $("#impMore"); if (b) { b.disabled = true; b.textContent = "Loading…"; } }
  try {
    const hits = await invoke("yt_search_playlists", { query: q, limit, offset: impSearchOffset });
    impSearchMore = Array.isArray(hits) && hits.length >= limit;
    impSearchOffset += hits?.length || 0;
    impHits.push(...(hits || []));
    if (!impHits.length) { host.innerHTML = `<div class="nx-note">No playlists found for “${esc(q)}”.</div>`; return; }
    impRenderHits();
  } catch (e) {
    if (more) { const b = $("#impMore"); if (b) { b.disabled = false; b.textContent = "Load more"; } flash("Load more failed"); }
    else host.innerHTML = `<div class="nx-note">Search failed: ${esc(String(e))}</div>`;
  }
}
function impRenderHits() {
  const host = $("#impHits");
  const sel = $("#impUrl").value;
  host.innerHTML = impHits.map((h, i) =>
    `<div class="imp-hit${h.url === sel ? " on" : ""}" data-hit="${i}" title="${esc(h.url)}">
      <span class="ih-t">${esc(h.title)}</span>
      <span class="ih-a">${esc(h.author || "")}</span>
      ${h._prev ? `<div class="ih-prev">${esc(h._prev)}</div>` : ""}
    </div>`).join("") +
    (impSearchMore ? `<button id="impMore" class="btn-line sm imp-more">Load more</button>` : "");
  host.querySelectorAll("[data-hit]").forEach(el => el.addEventListener("click", () => {
    host.querySelectorAll(".imp-hit").forEach(x => x.classList.toggle("on", x === el));
    $("#impUrl").value = impHits[Number(el.dataset.hit)].url;
    impFetch();
  }));
  $("#impMore")?.addEventListener("click", () => impSearchGo(true));
  impLoadPreviews();
}
// Background previews: first titles of each playlist, filled in lazily and cached.
async function impLoadPreviews() {
  const run = ++impPreviewRun;
  const host = $("#impHits");
  for (let i = 0; i < impHits.length; i++) {
    if (run !== impPreviewRun) return; // superseded by a newer render
    if (impHits[i]._prev) continue;
    const el = host.querySelector(`[data-hit="${i}"]`);
    if (!el || !el.isConnected) continue;
    try {
      const titles = await invoke("yt_playlist_preview", { url: impHits[i].url, count: 3 });
      if (run !== impPreviewRun) return;
      if (titles?.length) {
        impHits[i]._prev = titles.join("  ·  ");
        const cur = host.querySelector(`[data-hit="${i}"]`);
        if (cur && !cur.querySelector(".ih-prev")) cur.insertAdjacentHTML("beforeend", `<div class="ih-prev">${esc(impHits[i]._prev)}</div>`);
      }
    } catch { return; }
  }
}
async function impFetch() {
  const url = $("#impUrl").value.trim();
  if (!url) return;
  if (!IS_NATIVE) { flash("Playlist import needs the native app"); return; }
  $("#impStatus").textContent = "Fetching tracks… (you can close this window — it'll be in the Activity badge)";
  $("#impList").innerHTML = ""; $("#impFoot").hidden = true;
  const btn = $("#impFetch"); btn.disabled = true;
  const tid = taskStart("Fetching playlist", { detail: url.length > 60 ? url.slice(0, 57) + "…" : url });
  try {
    const res = await invoke("yt_playlist", { url });
    impTracks = (res.tracks || []).map(onlineFromResult);
    if (!impTracks.length) { $("#impStatus").textContent = "No tracks found at this URL."; taskEnd(tid, { status: "error", detail: "no tracks found" }); return; }
    // Register metadata for everything fetched: this also repairs the display
    // of already-downloaded files from this playlist (title/artist/artwork).
    impTracks.forEach(t => onlineIndex.set(t.path, t));
    saveOnline();
    if (enrichLibrary()) { saveLibrary(); refreshView(); }
    $("#impStatus").textContent = `“${res.title}” — ${impTracks.length} tracks. Untick what you don't want.`;
    $("#impList").innerHTML = impTracks.map((t, i) =>
      `<label class="imp-item"><input type="checkbox" data-imp="${i}" checked>
        <img data-net="${esc(t.thumbnail)}" alt="" loading="lazy">
        <span class="imp-meta"><span class="t">${esc(t.title)}</span><span class="s">${esc(t.artist)}${t.duration_secs ? " · " + fmtDur(t.duration_secs) : ""}</span></span>
      </label>`).join("");
    proxyCovers($("#impList")); // raw network <img> never loads on Android
    const pls = PL.getPlaylists();
    $("#impDest").innerHTML =
      `<option value="__new">New playlist — “${esc(res.title)}”</option>` +
      pls.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    $("#impDest").dataset.title = res.title;
    $("#impDest").dataset.url = url;
    $("#impFollow").checked = follows.some(f => f.url === url && f.enabled !== false);
    $("#impFoot").hidden = false;
    updateImpCount();
    // Modal closed while fetching → park the ready picker in Activity.
    if ($("#importModal").hidden) {
      taskEnd(tid, {
        detail: `“${res.title}” — ${impTracks.length} tracks ready — click to pick`,
        onClick: () => { $("#importModal").hidden = false; },
      });
      flash(`Playlist “${res.title}” ready — see the Activity badge`);
    } else {
      taskEnd(tid, { detail: `${impTracks.length} tracks`, ttl: 4000 });
    }
  } catch (e) { $("#impStatus").textContent = `Import failed: ${e}`; taskEnd(tid, { status: "error", detail: String(e) }); }
  finally { btn.disabled = false; }
}
function updateImpCount() {
  const boxes = [...document.querySelectorAll("#impList [data-imp]")];
  const n = boxes.filter(c => c.checked).length;
  const followOnly = !n && $("#impFollow").checked;
  $("#impCount").textContent = `${n} of ${boxes.length} selected`;
  $("#impGo").textContent = followOnly ? "Follow only" : n ? `Import ${n} track${n === 1 ? "" : "s"}` : "Import";
  $("#impGo").disabled = !n && !followOnly;
}
async function impGo() {
  const chosen = [...document.querySelectorAll("#impList [data-imp]")].filter(c => c.checked).map(c => impTracks[Number(c.dataset.imp)]);
  const following = $("#impFollow").checked;
  if (!chosen.length && !following) { flash("No tracks selected"); return; }
  let dest = $("#impDest").value;
  if (dest === "__new") dest = PL.createPlaylist($("#impDest").dataset.title).id;
  PL.setSourceUrl(dest, $("#impDest").dataset.url); // enables follow-after-import
  for (const t of chosen) { onlineIndex.set(t.path, t); PL.addToPlaylist(dest, t.path); }
  await saveOnline();
  if (following) {
    // Everything fetched now counts as "known" — only FUTURE additions to the
    // playlist will be auto-added (respecting the tracks the user unticked).
    addFollow({
      url: $("#impDest").dataset.url, title: $("#impDest").dataset.title,
      playlistId: dest, autoDownload: $("#impDl").checked,
      knownIds: impTracks.map(t => ytId(t.path)),
    });
  }
  renderPlaylists();
  $("#importModal").hidden = true;
  const nm = PL.getPlaylists().find(p => p.id === dest)?.name || "playlist";
  flash(chosen.length
    ? `Imported ${chosen.length} track${chosen.length === 1 ? "" : "s"} into “${nm}”${following ? " · following" : ""}`
    : `Following “${nm}” — new tracks will be added automatically`);
  openPlaylist(dest);
  if ($("#impDl").checked && chosen.length) downloadTracks(chosen.map(t => t.path)); // background batch
}

// ─── Download manager (queue + action bar, cancelable) ───
const dlQueue = []; // {path, id, title, status: queued|active|done|error|canceled, pct, tries, err}
let dlRunning = false, dlStopAll = false, dlNotice = "";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Only these errors are worth retrying: YouTube throttling/bot-check, the
// format-availability roulette, or network blips. EVERYTHING else (copyright
// claims, private/deleted, geo-block, age, premium…) is final — retrying just
// wastes quota and time.
const DL_TRANSIENT = [
  "not a bot", "sign in to confirm you", "429", "too many requests", "rate limit", "rate-limited",
  "http error 403", "format is not available", "no video formats",
  "unable to download", "connection", "timed out", "timeout", "temporary failure", "network", "getaddrinfo",
  "dns", "lookup address", "failed to lookup", "resolve dns", "dns error",
];
function dlTransientErr(msg) { const m = String(msg).toLowerCase(); return DL_TRANSIENT.some(s => m.includes(s)); }
const DL_ICON = { queued: IC.clock, active: IC.dl, done: IC.check, error: IC.alert, canceled: IC.slash };
// Permanently-unavailable videos (Premium-only, deleted, private, geo…):
// remembered across batches and restarts so they are never attempted again.
let dlBlock = {};
async function loadDlBlock() {
  const raw = await storeLoad("dlblock");
  if (raw) { try { dlBlock = JSON.parse(raw) || {}; } catch {} }
}
function saveDlBlock() { storeSave("dlblock", JSON.stringify(dlBlock)); }

// ─── Blocked tracks ─────────────────────────────────────────────────────
// A track can be "blocked" — hidden everywhere and unplayable (skipped in the
// queue) until unblocked, even if it's saved locally. Keyed by videoId when
// the track has one (so the local file AND its yt: alias are both blocked),
// else by path. Persisted in store "blocked". A setting reveals them (greyed).
let blockedKeys = new Set();
async function loadBlocked() {
  const raw = await storeLoad("blocked");
  if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a)) blockedKeys = new Set(a); } catch {} }
}
function saveBlocked() { storeSave("blocked", JSON.stringify([...blockedKeys])); }
function blockKeyOf(p) { const v = videoIdOf(p); return v ? "id:" + v : "path:" + p; }
function isBlocked(p) { return blockedKeys.has(blockKeyOf(p)); }
function setBlocked(paths, on) {
  for (const p of paths) { const k = blockKeyOf(p); if (on) blockedKeys.add(k); else blockedKeys.delete(k); }
  saveBlocked();
}
// Drop blocked tracks from a list unless the user chose to reveal them.
function filterBlocked(list) {
  if (S().showBlocked) return list;
  return list.filter(t => !isBlocked(t.path));
}
function autoBlockUnplayableTrack(path, reason = "") {
  if (!path) return;
  setBlocked([path], true);
  flash(reason ? `Track unplayable (${reason}) — automatically hidden` : "Track unplayable — automatically hidden");
  refreshView();
}

// ─── Resume unfinished downloads (Settings → Downloads) ───
// Persist the still-pending set so a relaunch can re-queue them; yt-dlp resumes
// any leftover .part file on its own. Only writes when the pending set changes.
let _dlqSig = "";
function saveDlQueue() {
  if (!S().resumeDownloads) { if (_dlqSig) { _dlqSig = ""; storeSave("dlqueue", ""); } return; }
  const pending = dlQueue.filter(d => d.status === "queued" || d.status === "active")
    .map(d => ({ path: d.path, id: d.id, title: d.title }));
  const sig = pending.map(p => p.path).join("|");
  if (sig === _dlqSig) return;
  _dlqSig = sig;
  storeSave("dlqueue", pending.length ? JSON.stringify(pending) : "");
}
async function resumeDownloads() {
  if (!S().resumeDownloads) return;
  const raw = await storeLoad("dlqueue");
  if (!raw) return;
  let items; try { items = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(items) || !items.length) return;
  for (const it of items) {
    if (it.path && !onlineIndex.has(it.path)) {
      onlineIndex.set(it.path, { path: it.path, id: it.id, title: it.title || it.path, artist: "", album: "YouTube", duration_secs: 0, gain: 1, thumbnail: "" });
    }
  }
  const paths = items.map(it => it.path).filter(Boolean);
  if (paths.length) { downloadTracks(paths); flash(`Resuming ${paths.length} download${paths.length === 1 ? "" : "s"}…`); }
}

// ─── Background tasks (search, imports, refreshes) ─────────────────────────
// Same UX as downloads: anything long-running lives in the Activity drawer
// (badge in the bottom bar), never holds the UI hostage, cancellable when the
// underlying work can stop. Rows reuse the .dl-row look.
const bgTasks = new Map(); // id → { label, detail, status: run|done|error, pct, cancel, onClick }
let _taskSeq = 0;
function taskStart(label, opts = {}) {
  const id = `task-${++_taskSeq}`;
  bgTasks.set(id, { label, detail: opts.detail || "", status: "run", pct: opts.pct ?? null, cancel: opts.cancel || null, onClick: null });
  dlRender();
  return id;
}
// Progress ticks patch the open row in place — no full drawer re-render.
function taskUpdate(id, patch) {
  const t = bgTasks.get(id);
  if (!t) return;
  Object.assign(t, patch);
  const row = $("#dlList")?.querySelector(`[data-task="${id}"]`);
  if (!row) return;
  row.querySelector(".dl-name").textContent = t.detail ? `${t.label} — ${t.detail}` : t.label;
  if (t.pct != null) {
    const i = row.querySelector(".dl-prog i"); if (i) i.style.width = `${t.pct}%`;
    const p = row.querySelector(".dl-pct"); if (p) p.textContent = `${Math.round(t.pct)}%`;
  }
}
function taskDrop(id) { if (bgTasks.delete(id)) dlRender(); }
function taskEnd(id, { status = "done", detail = "", onClick = null, ttl = 12000 } = {}) {
  const t = bgTasks.get(id);
  if (!t) return;
  Object.assign(t, { status, detail, pct: status === "done" ? 100 : t.pct, cancel: null, onClick });
  dlRender();
  // Clickable results stick around longer so they can actually be clicked.
  setTimeout(() => { if (bgTasks.get(id) === t && t.status !== "run") taskDrop(id); }, onClick ? ttl * 5 : ttl);
}
function taskRow(id, t) {
  const st = t.status === "run" ? "active" : t.status;
  return `<div class="dl-row task-row ${st} ${t.onClick ? "clickable" : ""}" data-task="${id}" title="${esc(t.detail || t.label)}">
      <span class="dl-ico">${t.status === "run" ? IC.radio : t.status === "done" ? IC.check : IC.alert}</span>
      <span class="dl-name">${esc(t.detail ? `${t.label} — ${t.detail}` : t.label)}</span>
      <span class="dl-prog"><i style="width:${t.status === "done" ? 100 : (t.pct ?? (t.status === "run" ? 0 : 100))}%"></i></span>
      <span class="dl-pct">${t.status === "run" ? (t.pct != null ? Math.round(t.pct) + "%" : "…") : t.status === "done" ? "done" : "failed"}</span>
      ${t.cancel ? `<button class="dl-x" data-tskx="${id}" title="Cancel">${IC.x}</button>` : ""}
    </div>`;
}

function dlRow(d) {
  const badge = d.permanent ? IC.slash : DL_ICON[d.status];
  const cover = d.thumbnail
    ? `<span class="dl-cover has-cover" style="background-image:url('${esc(d.thumbnail)}')"></span>`
    : `<span class="dl-cover">${badge}</span>`;
  return `
    <div class="dl-row ${d.status}" data-path="${esc(d.path)}" data-id="${esc(d.id)}" title="${esc(d.err || d.title)}">
      ${cover}
      <span class="dl-name">${esc(d.title)}${d.status === "error" && d.err ? `<span class="dl-err">${esc(d.err.slice(0, 140))}</span>` : ""}</span>
      <span class="dl-prog"><i style="width:${d.status === "done" ? 100 : (d.pct || 0)}%"></i></span>
      <span class="dl-pct">${d.status === "active" ? (d.pct || 0) + "%" : d.status}</span>
      ${d.status === "queued" || d.status === "active" ? `<button class="dl-x" data-dlx="${esc(d.path)}" title="Cancel">${IC.x}</button>` : ""}
    </div>`;
}
let dlOpen = false; // drawer is opt-in: nothing pops up on its own
function dlRender() {
  saveDlQueue(); // persist the pending set whenever it changes
  const bar = $("#dlBar"), tog = $("#dlToggle");
  if (!dlQueue.length && !bgTasks.size) { bar.hidden = true; tog.hidden = true; dlOpen = false; return; }
  const n = { done: 0, error: 0, canceled: 0, queued: 0, active: 0 };
  for (const d of dlQueue) n[d.status]++;
  const tRun = [...bgTasks.values()].filter(t => t.status === "run").length;
  const busy = n.queued + n.active > 0 || tRun > 0;
  // Discreet badge at the edge — the panel only opens when the user clicks it.
  tog.hidden = false;
  tog.classList.toggle("busy", busy);
  $("#dlBadge").textContent = dlQueue.length
    ? `${n.done}/${dlQueue.length}${busy ? "" : " ✓"}`
    : (tRun ? `${tRun}⋯` : "✓");
  tog.title = (dlQueue.length ? `Downloads — ${n.done}/${dlQueue.length} saved` : "Activity") +
    (tRun ? ` · ${tRun} task${tRun === 1 ? "" : "s"} running` : "") +
    (n.error ? ` · ${n.error} failed` : "") + (dlNotice ? ` · ${dlNotice}` : "") + " (click to open)";
  bar.hidden = !dlOpen;
  if (!dlOpen) return;
  $("#dlTitle").textContent =
    (bgTasks.size ? `Activity${tRun ? ` — ${tRun} running` : ""}${dlQueue.length ? " · " : ""}` : "") +
    (dlQueue.length
      ? (busy && n.queued + n.active > 0 ? `Downloading… ${n.done}/${dlQueue.length}` : `Downloads — ${n.done}/${dlQueue.length} saved`) +
        (n.error ? ` · ${n.error} failed` : "") + (n.canceled ? ` · ${n.canceled} canceled` : "") +
        (dlNotice ? ` · ${dlNotice}` : "")
      : "");
  $("#dlAction").textContent = n.queued + n.active > 0 ? "Stop all" : "Clear"; // tasks cancel via their own ✕
  // Only rate-limit failures + canceled are retriable; final refusals
  // (copyright/private/geo…) stay out — retrying them can't succeed.
  const retriable = dlQueue.filter(d => d.status === "canceled" || (d.status === "error" && !d.permanent)).length;
  const dlBusy = n.queued + n.active > 0;
  $("#dlRetry").hidden = dlBusy || !retriable;
  if (retriable) $("#dlRetry").textContent = `Retry ${retriable}`;
  // Blocked/skipped tracks (copyright/private/geo… or wrongly-blocked while
  // downloads were broken) can be force-retried — unblocks + requeues them.
  const blocked = dlQueue.filter(d => d.status === "error" && d.permanent).length;
  $("#dlRetryBlocked").hidden = dlBusy || !blocked;
  if (blocked) $("#dlRetryBlocked").textContent = `Retry blocked ${blocked}`;

  // Windowed render: active + next queued + recent finished — never 1000+ rows.
  const active = dlQueue.filter(d => d.status === "active");
  const queued = dlQueue.filter(d => d.status === "queued");
  const finished = dlQueue.filter(d => !["queued", "active"].includes(d.status));
  const parts = [
    ...[...bgTasks.entries()].map(([id, t]) => taskRow(id, t)),
    ...active.map(dlRow),
    ...queued.slice(0, 12).map(dlRow),
    queued.length > 12 ? `<div class="dl-more">… ${queued.length - 12} more queued</div>` : "",
    ...finished.slice(-8).reverse().map(dlRow),
    finished.length > 8 ? `<div class="dl-more">… ${finished.length - 8} more finished</div>` : "",
  ];
  $("#dlList").innerHTML = parts.join("");
  proxyCovers($("#dlList"));
  $("#dlList").querySelectorAll("[data-tskx]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const t = bgTasks.get(b.dataset.tskx);
    if (t?.cancel) { try { t.cancel(); } catch {} taskUpdate(b.dataset.tskx, { detail: "canceling…" }); }
  }));
  $("#dlList").querySelectorAll(".task-row.clickable").forEach(el => el.addEventListener("click", () => {
    const t = bgTasks.get(el.dataset.task);
    if (!t?.onClick) return;
    bgTasks.delete(el.dataset.task);
    dlOpen = false; dlRender();
    t.onClick();
  }));
  $("#dlList").querySelectorAll("[data-dlx]").forEach(b => b.addEventListener("click", () => dlCancel(b.dataset.dlx)));
  $("#dlList").querySelectorAll(".dl-row[data-path]").forEach(el => el.addEventListener("contextmenu", e => { e.preventDefault(); openDlCtx(e.clientX, e.clientY, el.dataset.path); }));
}
function dlProgress(id, pct) {
  const d = dlQueue.find(x => x.status === "active" && x.id === id);
  if (!d) return;
  // Monotonic per track: yt-dlp reports several download phases (audio, then
  // the thumbnail for embedding), each 0→100 — without the clamp the bar
  // visibly jumped backwards between phases.
  d.pct = Math.max(d.pct || 0, Math.max(0, Math.min(100, pct)));
  // Multiple rows can be active at once — route the update to the matching id.
  const row = [...($("#dlList")?.querySelectorAll(".dl-row.active") || [])].find(r => r.dataset.id === id);
  if (row) { row.querySelector(".dl-prog i").style.width = d.pct + "%"; row.querySelector(".dl-pct").textContent = d.pct + "%"; }
}
function dlCancel(path) {
  const d = dlQueue.find(x => x.path === path && (x.status === "queued" || x.status === "active"));
  if (!d) return;
  if (d.status === "queued") { d.status = "canceled"; dlRender(); }
  else invoke("yt_cancel", { id: d.id }).catch(() => {});
}
function dlStop() {
  if (dlQueue.some(d => d.status === "queued" || d.status === "active")) {
    dlStopAll = true;
    dlQueue.forEach(d => { if (d.status === "queued") d.status = "canceled"; });
    // Multiple downloads can be in flight at once — cancel every active one.
    for (const act of dlQueue.filter(d => d.status === "active")) invoke("yt_cancel", { id: act.id }).catch(() => {});
    dlRender();
  } else {
    // Clear: drop finished downloads AND finished background tasks.
    dlQueue.length = 0;
    for (const [id, t] of bgTasks) if (t.status !== "run") bgTasks.delete(id);
    dlRender();
  }
}
// Right-click actions on a download row.
function openDlCtx(x, y, path) {
  const d = dlQueue.find(v => v.path === path);
  if (!d) return;
  const menu = $("#ctxMenu");
  const parts = [];
  if ((d.status === "error" && !d.permanent) || d.status === "canceled") parts.push(`<div class="ctx-item" data-a="retry">${ic(IC.refresh)}Retry this track</div>`);
  else if (d.status === "error" && d.permanent) parts.push(`<div class="ctx-item" data-a="force">${ic(IC.refresh)}Retry anyway (unblock)</div>`);
  if (d.status === "queued" || d.status === "active") parts.push(`<div class="ctx-item" data-a="cancel">${ic(IC.x)}Cancel</div>`);
  parts.push(`<div class="ctx-item" data-a="drop">Remove from this list</div>`);
  parts.push(`<div class="ctx-sep"></div>`);
  parts.push(`<div class="ctx-item ctx-danger" data-a="unpl">Remove from playlists</div>`);
  menu.innerHTML = parts.join("");
  placeCtx(menu, x, y);
  menu.querySelectorAll("[data-a]").forEach(it => it.addEventListener("click", async () => {
    const a = it.dataset.a;
    closeCtx();
    if (a === "retry" || a === "force") {
      if (a === "force") { d.permanent = false; delete dlBlock[d.id]; saveDlBlock(); }
      d.status = "queued"; d.pct = 0; d.err = ""; d.tries = 0; dlRender(); if (!dlRunning) dlPump();
    }
    else if (a === "cancel") dlCancel(path);
    else if (a === "drop") {
      if (d.status === "active") dlCancel(path);
      const at = dlQueue.indexOf(d);
      if (at >= 0) dlQueue.splice(at, 1);
      dlRender();
    }
    else if (a === "unpl") {
      if (!await askConfirm("Remove this track from all playlists?", d.title, "Remove")) return;
      if (d.status === "queued") d.status = "canceled";
      else if (d.status === "active") dlCancel(path);
      const local = libraryLocalFor(d.id);
      for (const pl of PL.getPlaylists()) {
        PL.removeFromPlaylist(pl.id, path);
        if (local) PL.removeFromPlaylist(pl.id, local);
      }
      saveOnline(); renderPlaylists(); refreshView(); dlRender();
      flash(`Removed “${d.title}” from playlists`);
    }
  }));
}

function dlRetry() {
  for (const d of dlQueue) {
    if (d.permanent) continue; // final refusals (copyright/private/geo…) stay skipped
    if (d.status === "error" || d.status === "canceled") { d.status = "queued"; d.pct = 0; d.err = ""; d.tries = 0; }
  }
  dlRender();
  if (!dlRunning) dlPump();
}
// Force-retry the skipped/blocked tracks: clear them from the never-retry list
// and requeue. Useful after the download path itself was fixed.
function dlRetryBlocked() {
  let n = 0;
  for (const d of dlQueue) {
    if (d.status === "error" && d.permanent) {
      d.permanent = false; delete dlBlock[d.id];
      d.status = "queued"; d.pct = 0; d.err = ""; d.tries = 0; n++;
    }
  }
  if (n) { saveDlBlock(); flash(`Retrying ${n} blocked track${n === 1 ? "" : "s"}`); }
  dlRender();
  if (!dlRunning) dlPump();
}
async function downloadPlaylist(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const online = pl.paths.filter(isOnline);
  if (!online.length) { flash("All tracks of this playlist are already local"); return; }
  if (!await askConfirm(`Save “${pl.name}” locally?`, `${online.length} track${online.length === 1 ? "" : "s"} will be downloaded as mp3 (already-downloaded ones are skipped).`, "Download")) return;
  downloadTracks(online);
}
// A file for this video id already in the library (ANY source folder — the
// desktop script and the app share the "Title [id].ext" naming convention).
function libraryLocalFor(id) {
  if (!id) return null;
  const tag = `[${id}]`;
  const t = library.find(x => !isOnline(x.path) && (x.path.includes(tag) || x.id === id || x.videoId === id || videoIdOf(x.path) === id));
  return t ? t.path : null;
}
function downloadTracks(paths) {
  if (!IS_NATIVE) { flash("Downloads need the native app"); return; }
  let added = 0, linked = 0, blocked = 0;
  for (const p of paths) {
    if (!isOnline(p)) continue;
    if (dlQueue.some(d => d.path === p && (d.status === "queued" || d.status === "active"))) continue;
    const local = libraryLocalFor(ytId(p));
    if (local) { PL.replacePath(p, local); linked++; continue; } // no download needed
    if (dlBlock[ytId(p)]) { blocked++; continue; } // known-unavailable: never retried
    const t = onlineIndex.get(p);
    dlQueue.push({ path: p, id: ytId(p), title: t?.title || p, thumbnail: t?.thumbnail || "", status: "queued", pct: 0 });
    added++;
  }
  if (linked) { saveOnline(); renderPlaylists(); refreshView(); }
  const skipNote = blocked ? ` · ${blocked} unavailable skipped` : "";
  if (!added) { flash((linked ? `${linked} track${linked === 1 ? "" : "s"} already local` : blocked ? "Nothing to download" : "Already in the download queue") + skipNote); return; }
  if (linked || blocked) flash(`Downloading ${added}${linked ? ` · ${linked} already local` : ""}${skipNote}`);
  dlRender();
  if (!dlRunning) dlPump();
}
let _dlErrShown = false;
// Bounded worker pool: up to S().dlConcurrency runners each pick the next
// "queued" item and drive it exactly like the old sequential pump did — same
// health check, same local-link shortcut, same storage cap, same transient
// retry/cooldown ladder, now shared across the whole pool instead of one
// track at a time. MAX_DL_WORKERS caps the pool at the highest selectable
// setting (4); each runner re-reads dlConcurrency before every pickup so a
// mid-batch change is honored (lazily) without restarting the batch.
const MAX_DL_WORKERS = 4;
async function dlPump() {
  if (dlRunning) return; // no-op if a pump is already driving the queue
  dlRunning = true;
  dlStopAll = false;
  _dlErrShown = false;

  // Health check before churning through the queue: if yt-dlp itself is
  // broken/missing, fail the whole batch at once with the real reason.
  // Skipped on Android — there's no yt-dlp there (the built-in engine downloads),
  // and the yt-dlp probe threw "no HOME directory", failing every download.
  try { if (!IS_ANDROID) await ytConfigPush(); }
  catch (e) {
    for (const d of dlQueue) if (d.status === "queued") { d.status = "error"; d.err = String(e); }
    dlRunning = false; dlRender();
    flash(`Downloads unavailable: ${e}`);
    return;
  }

  let dir = "", ok = 0, cooldownIdx = 0, consecTransient = 0, capHit = false;
  dlNotice = "";
  // Storage cap: skip new downloads once the target folder passes the limit.
  const capMb = Math.max(0, Number(S().storageCapMb) || 0);
  // Pool-wide pause for the rate-limit cooldown ladder: while `cooling` is
  // true, no runner picks up a new item, but whatever is already in flight
  // is left to finish — exactly like the old single-track cooldown, just
  // scoped to every runner instead of the lone active download.
  let cooling = false;
  async function runCooldown() {
    if (cooling) return; // another runner is already driving this countdown
    cooling = true;
    const COOLDOWNS = [120, 300, 600, 1200];
    const wait = COOLDOWNS[Math.min(cooldownIdx, COOLDOWNS.length - 1)];
    cooldownIdx++;
    consecTransient = 0;
    for (let s = wait; s > 0 && !dlStopAll; s--) {
      dlNotice = `⏸ YouTube rate-limit — resuming in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      dlRender();
      await sleep(1000);
    }
    dlNotice = "";
    dlRender();
    cooling = false;
  }

  async function runner() {
    for (;;) {
      if (dlStopAll) return;
      if (cooling) { await sleep(300); continue; }
      const limit = Math.max(1, Math.min(MAX_DL_WORKERS, Number(S().dlConcurrency) || 3));
      const activeNow = dlQueue.filter(x => x.status === "active").length;
      if (activeNow >= limit) { await sleep(300); continue; } // pool at its configured cap
      const d = dlQueue.find(x => x.status === "queued");
      if (!d) {
        if (activeNow === 0) return; // nothing left, nothing in flight: this runner is done
        await sleep(300); continue; // an in-flight item may still requeue on a transient error
      }
      // Claim it synchronously (no await above this line since the concurrency
      // check) so two runners can never grab the same queued item.
      d.status = "active"; d.pct = 0;
      // The library may have grown mid-batch (rescans): link instead of downloading.
      const local = libraryLocalFor(d.id);
      if (local) {
        d.status = "done"; d.pct = 100;
        PL.replacePath(d.path, local);
        dlRender();
        continue;
      }
      // Enforce the storage cap before spending bandwidth on a new file.
      if (capMb && IS_NATIVE) {
        try {
          const dlDir = dir || S().downloadDir || (IS_ANDROID ? ANDROID_MUSIC_DIR + "/MusicPlayer" : "");
          if (dlDir) {
            const bytes = await invoke("folder_size", { path: dlDir });
            if (bytes >= capMb * 1024 * 1024) {
              capHit = true;
              d.status = "error"; d.permanent = true; d.err = "storage cap reached";
              for (const x of dlQueue) if (x.status === "queued") { x.status = "error"; x.permanent = true; x.err = "storage cap reached"; }
              dlRender();
              continue;
            }
          }
        } catch {}
      }
      if (dlStopAll) { d.status = "canceled"; dlRender(); continue; }
      dlRender();
      try {
        const file = await invoke("yt_download", { id: d.id, dir: S().downloadDir || "", quality: S().downloadQuality || "best" });
        d.status = "done"; d.pct = 100; ok++; cooldownIdx = 0; consecTransient = 0;
        dir = file.slice(0, file.lastIndexOf("/"));
        PL.replacePath(d.path, file); // playlists now point at the local file
        const meta = onlineIndex.get(d.path) || {};
        if (!library.some(x => x.path === file)) {
          library.push({
            path: file,
            title: d.title || meta.title || baseName(file),
            artist: meta.artist || "Unknown Artist",
            album: meta.album || "YouTube Downloads",
            duration_secs: meta.duration_secs || d.duration_secs || 0,
            gain: 1,
            thumbnail: meta.thumbnail || d.thumbnail || ""
          });
        }
        await saveLibrary();
        await saveOnline();
        renderPlaylists();
        refreshView();
      } catch (e) {
        const msg = String(e);
        if (msg.includes("canceled") || dlStopAll) { d.status = "canceled"; }
        else if (dlTransientErr(msg)) {
          // Rate-limit-style refusal or network blip: never abandon the track —
          // requeue it at the BACK so one stubborn video doesn't block the
          // batch, and retry it later.
          d.tries = (d.tries || 0) + 1;
          consecTransient++;
          console.warn("[download transient]", d.id, `try ${d.tries}`, msg);
          if (d.tries >= 4) { d.status = "error"; d.err = `${msg} (after ${d.tries} tries)`; }
          else {
            d.status = "queued"; d.err = msg;
            const at = dlQueue.indexOf(d);
            if (at >= 0) { dlQueue.splice(at, 1); dlQueue.push(d); }
          }
        } else {
          // Final refusal (copyright claim, private/deleted, geo/age/premium…):
          // mark it, remember it forever, move on — no retry, no cooldown.
          d.status = "error"; d.permanent = true; d.err = msg;
          dlBlock[d.id] = msg; saveDlBlock();
          console.error("[download final]", d.id, msg);
          // Surface the reason once (permission / storage errors are otherwise
          // buried in the downloads panel — the #1 "downloads don't work" cause).
          if (!_dlErrShown) { _dlErrShown = true; flash(`Download failed: ${msg.slice(0, 120)}`); }
        }
      }
      dlRender();
      if (dlStopAll) return;

      if (consecTransient >= 3) {
        // Three transient refusals in a row across the pool = real rate limit.
        // Pause every runner (progressively longer, capped at 20 min, repeated
        // as needed) — after any success the ladder resets to short waits.
        await runCooldown();
      } else if (dlQueue.some(x => x.status === "queued")) {
        // Polite pacing between tracks (the script sleeps 2-5s for the same reason).
        await sleep(1200 + Math.random() * 1800);
      }
    }
  }

  // Always spawn the max pool size; each runner's own concurrency check
  // (re-read every pickup) is what actually throttles active downloads to
  // S().dlConcurrency, so raising/lowering the setting mid-batch takes
  // effect at the next pickup instead of waiting for a fresh dlPump() call.
  await Promise.all(Array.from({ length: MAX_DL_WORKERS }, runner));

  if (dir) {
    if (!folders.includes(dir)) folders.push(dir);
    await rescanFolder(dir); // picks up the new files with proper tags
  }
  await saveOnline();
  renderPlaylists(); refreshView();
  dlRunning = false;
  dlRender();
  if (capHit) flash(`Storage cap reached (${capMb} MB) — remaining downloads skipped`);
  else if (ok) flash(`${ok} track${ok === 1 ? "" : "s"} saved locally`);
}

// Your Library means everything you have, not everything you downloaded. Online
// tracks sitting in playlists are adopted into the library so they show up here
// without ever being saved as mp3. Adoption is one-way on purpose: dropping a
// track from a playlist should not make it disappear from your library.
// Cheap when there is nothing new, so it can run on every open and self-heal
// after imports, follows and playlist edits without hooking each of them.
function adoptPlaylistOnline() {
  const have = new Set(library.map(t => t.path));
  const add = [];
  for (const pl of PL.getPlaylists()) {
    for (const p of pl.paths) {
      if (!isOnline(p) || have.has(p)) continue;
      const t = ensureOnlineTrack(p);
      if (!t) continue;
      have.add(p);
      add.push(t);
    }
  }
  if (!add.length) return 0;
  library = library.concat(add);
  return add.length;
}

async function refreshActiveViewAction() {
  const btns = document.querySelectorAll("#libRefreshBtn, #plRefreshBtn");
  btns.forEach(b => b.classList.add("spinning"));
  flash("Refreshing titles, icons & covers…");
  try {
    for (const d of dlQueue) {
      if (d.status === "done" && d.id) {
        const local = libraryLocalFor(d.id);
        if (local && d.path) {
          PL.replacePath(d.path, local);
        }
      }
    }
    if (active.type === "library") {
      enrichLibrary();
      await loadOnline();
      saveLibrary();
      showLibrary();
    } else if (active.type === "playlist") {
      await loadOnline();
      adoptPlaylistOnline();
      openPlaylist(active.id);
    } else if (active.type === "source") {
      rescanFolder(active.id);
    } else {
      refreshView();
    }
    flash("Refreshed titles, icons & covers");
  } catch (e) {
    console.error("[refresh]", e);
    refreshView();
    flash("Refreshed view");
  } finally {
    btns.forEach(b => b.classList.remove("spinning"));
  }
}

function showLibrary() {
  active = { type: "library", id: "" };
  markActive();
  selected.clear();
  if (adoptPlaylistOnline()) saveLibrary();
  const artists = new Set(library.map(t => t.artist)).size;
  const nOnline = library.filter(t => isOnline(t.path)).length;
  // The library behaves like a playlist you cannot delete: same header, same
  // actions, same drag-to-reorder. "Follow" is deliberately absent — following
  // mirrors an upstream playlist, and the library has no upstream to mirror.
  setViewHead({
    icon: IC.disc,
    title: "Your Library",
    subtitle: `${library.length} songs · ${artists} artist${artists === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}${nOnline ? ` · ${nOnline} online` : ""}`,
    actions:
      `<button id="libRefreshBtn" class="btn-line sm" title="Refresh titles, covers, and icons">${ic(IC.refresh)} Refresh</button>` +
      `<button id="libUrlBtn" class="btn-line sm" title="Add a YouTube video or playlist by URL">${ic(IC.link)} Add from URL</button>` +
      // Always shown, unlike on a playlist: the library is the home view, and a
      // control that vanishes whenever nothing is downloadable reads as missing
      // rather than as "nothing to do". With no online tracks it stays enabled
      // and says so on click.
      `<button id="libDlBtn" class="btn-line sm"${nOnline ? "" : ` title="Nothing to download — everything here is already local"`}>${ic(IC.save)} Save locally${nOnline ? ` (${nOnline} mp3)` : ""}</button>` +
      `<button id="libDupsBtn" class="btn-line sm" title="Check and remove duplicate songs">${ic(IC.filter)} Clean duplicates</button>`,
  });
  $("#libRefreshBtn")?.addEventListener("click", refreshActiveViewAction);
  $("#libUrlBtn")?.addEventListener("click", addUrlToLibrary);
  $("#libDlBtn")?.addEventListener("click", downloadLibraryOnline);
  $("#libDupsBtn")?.addEventListener("click", () => checkDuplicatesFlow("library"));
  renderTracks(library);
}

// "Add from URL" for the library. Mirrors addByUrl(), but the destination is
// the library array itself instead of a playlist's paths.
async function addUrlToLibrary() {
  if (!IS_NATIVE) { flash("Adding by URL needs the native app"); return; }
  const url = await askText("Add from URL", { placeholder: "YouTube video or playlist URL", ok: "Add" });
  if (!url) return;
  flash("Fetching…");
  try {
    const res = await invoke("yt_playlist", { url: url.trim() });
    const tracks = (res.tracks || []).map(onlineFromResult);
    if (!tracks.length) { flash("Nothing found at that URL"); return; }
    tracks.forEach(t => onlineIndex.set(t.path, t));
    const have = new Set(library.map(t => t.path));
    const fresh = tracks.filter(t => !have.has(t.path));
    library = library.concat(fresh);
    saveOnline();
    await saveLibrary();
    if (active.type === "library") showLibrary();
    flash(fresh.length ? `Added ${fresh.length} track${fresh.length === 1 ? "" : "s"}` : "Already in your library");
  } catch (e) { flash(`Could not add: ${e}`); }
}

async function downloadLibraryOnline() {
  const online = library.filter(t => isOnline(t.path)).map(t => t.path);
  if (!online.length) { flash("Everything in your library is already local"); return; }
  if (!await askConfirm("Save these locally?", `${online.length} track${online.length === 1 ? "" : "s"} will be downloaded as mp3 (already-downloaded ones are skipped).`, "Download")) return;
  downloadTracks(online);
}

// ─── Duplicate Checker ───
function findDuplicates(tracks) {
  const byVid = new Map();
  const byPath = new Map();
  const byTitleArt = new Map();

  for (const t of tracks) {
    if (!t || !t.path) continue;
    const vid = videoIdOf(t.path);
    if (vid) {
      if (!byVid.has(vid)) byVid.set(vid, []);
      byVid.get(vid).push(t);
    }
    if (!byPath.has(t.path)) byPath.set(t.path, []);
    byPath.get(t.path).push(t);

    const normTitle = String(t.title || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const normArtist = String(t.artist || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    if (normTitle && normTitle !== "unknown") {
      const key = normArtist && normArtist !== "unknown" ? `${normTitle}|||${normArtist}` : normTitle;
      if (!byTitleArt.has(key)) byTitleArt.set(key, []);
      byTitleArt.get(key).push(t);
    }
  }

  const dupGroups = [];
  const processedPaths = new Set();

  const addGroup = (groupTracks, reason) => {
    const unassigned = groupTracks.filter(t => !processedPaths.has(t.path));
    if (unassigned.length < 2 && groupTracks.length < 2) return;

    const allInGroup = [...groupTracks];
    allInGroup.sort((a, b) => {
      const aLocal = localFileFor(a.path) ? 2 : 0;
      const bLocal = localFileFor(b.path) ? 2 : 0;
      if (aLocal !== bLocal) return bLocal - aLocal;
      const aRich = (a.thumbnail ? 1 : 0) + (a.duration_secs ? 1 : 0);
      const bRich = (b.thumbnail ? 1 : 0) + (b.duration_secs ? 1 : 0);
      return bRich - aRich;
    });

    const keep = allInGroup[0];
    const dups = allInGroup.slice(1);
    const newDups = dups.filter(d => !processedPaths.has(d.path));
    if (newDups.length > 0) {
      allInGroup.forEach(t => processedPaths.add(t.path));
      dupGroups.push({ keep, duplicates: dups, allTracks: allInGroup, reason });
    }
  };

  for (const [vid, group] of byVid.entries()) {
    if (group.length > 1) addGroup(group, `Same YouTube ID (${vid})`);
  }
  for (const [p, group] of byPath.entries()) {
    if (group.length > 1) addGroup(group, "Identical path");
  }
  for (const [key, group] of byTitleArt.entries()) {
    if (group.length > 1) addGroup(group, "Same Title & Artist");
  }

  return dupGroups;
}

function openDupModal({ groups, totalDups, scopeName, onConfirm }) {
  const modal = $("#dupModal");
  if (!modal) return;
  $("#dupTitle").textContent = "Clean Duplicates";
  $("#dupSummary").innerHTML = `Found <b>${totalDups}</b> duplicate song${totalDups === 1 ? "" : "s"} in this ${scopeName}.`;

  const listEl = $("#dupList");
  listEl.innerHTML = groups.map(g => `
    <div style="margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid var(--border, rgba(255,255,255,0.1));">
      <div style="font-weight:600; color:var(--fg, #fff);">${esc(g.keep.title)} <span style="font-weight:normal; opacity:0.7;">— ${esc(g.keep.artist)}</span></div>
      <div style="font-size:11px; color:#4ade80; margin-top:2px;">✔ Keeping: ${isStreamTrack(g.keep) ? "Online stream" : esc(baseName(localFileFor(g.keep.path) || g.keep.path))}</div>
      ${g.duplicates.map(d => `
        <div style="font-size:11px; color:#f87171; margin-top:2px;">✖ Removing: ${isStreamTrack(d) ? "Online stream" : esc(baseName(localFileFor(d.path) || d.path))}</div>
      `).join("")}
    </div>
  `).join("");

  $("#dupDelFiles").checked = false;
  $("#dupConfirm").textContent = `Remove ${totalDups} Duplicate${totalDups === 1 ? "" : "s"}`;
  modal.hidden = false;

  const close = () => { modal.hidden = true; };
  $("#dupClose").onclick = close;
  $("#dupCancel").onclick = close;
  $("#dupConfirm").onclick = () => {
    close();
    onConfirm($("#dupDelFiles").checked);
  };
}

async function checkDuplicatesFlow(type, plId = "") {
  let tracks = [];
  if (type === "playlist") {
    const pl = PL.getPlaylists().find(p => p.id === plId);
    if (!pl) return;
    const by = new Map(library.map(t => [t.path, t]));
    tracks = pl.paths.map(p => by.get(p) || ensureOnlineTrack(p)).filter(Boolean);
  } else {
    tracks = library;
  }

  const groups = findDuplicates(tracks);
  if (!groups.length) {
    flash("No duplicate songs found");
    return;
  }

  const totalDups = groups.reduce((acc, g) => acc + g.duplicates.length, 0);

  openDupModal({
    groups,
    totalDups,
    scopeName: type === "playlist" ? "playlist" : "library",
    onConfirm: async (delDiskFiles) => {
      const dupPaths = new Set();
      groups.forEach(g => g.duplicates.forEach(d => dupPaths.add(d.path)));

      if (type === "playlist") {
        const pl = PL.getPlaylists().find(p => p.id === plId);
        if (pl) {
          pl.paths = pl.paths.filter(p => !dupPaths.has(p));
          PL._persist?.();
        }
      } else {
        library = library.filter(t => !dupPaths.has(t.path));
        await saveLibrary();
      }

      if (delDiskFiles) {
        const filesToDelete = [];
        for (const g of groups) {
          const localFiles = [...new Set(g.allTracks.map(t => localFileFor(t.path)).filter(p => p && !isOnline(p)))];
          if (localFiles.length >= 2) {
            filesToDelete.push(...localFiles.slice(1));
          }
        }
        if (filesToDelete.length > 0) {
          await deleteLocalFiles(filesToDelete);
        }
      }

      saveOnline();
      renderPlaylists();
      refreshView();
      flash(`Removed ${totalDups} duplicate song${totalDups === 1 ? "" : "s"}`);
    }
  });
}
function markActive() {
  $("#navLibrary").classList.toggle("active", active.type === "library");
  $("#navHistory").classList.toggle("active", active.type === "history");
  renderSources();
  // playlist highlight is refreshed by renderPlaylists on open; refresh to sync
  document.querySelectorAll("#playlistsList .pl-row[data-pl]").forEach(el => el.classList.toggle("active", active.type === "playlist" && active.id === el.dataset.pl));
}

// ─── Playback (gapless) ───
// Shuffle = a pre-computed permutation of the queue (like real players), so
// the upcoming order is stable, visible in "Up next", and never repeats a
// track until the whole queue has played.
let shufOrder = [];
function buildShuffle(startIdx) {
  shufOrder = queue.map((_, i) => i);
  for (let i = shufOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shufOrder[i], shufOrder[j]] = [shufOrder[j], shufOrder[i]];
  }
  if (startIdx >= 0) {
    const p = shufOrder.indexOf(startIdx);
    if (p > 0) { shufOrder.splice(p, 1); shufOrder.unshift(startIdx); }
  }
}
function playOrder() {
  if (!shuffle) return queue.map((_, i) => i);
  if (shufOrder.length !== queue.length) buildShuffle(curIndex);
  return shufOrder;
}
// Queue indexes that will play after the current track (repeat-aware).
function upcomingIndexes(max = 25) {
  const out = [];
  if (curIndex < 0 || !queue.length || repeatMode === "one") return out;
  const order = playOrder();
  const pos = order.indexOf(curIndex);
  for (let k = 1; k < order.length && out.length < max; k++) {
    const at = pos + k;
    if (at < order.length) out.push(order[at]);
    else if (repeatMode === "all") out.push(order[at - order.length]);
    else break;
  }
  return out;
}
// `manual` = user pressed Next: skips repeat-one and still wraps on repeat-all.
function nextIndex(from, manual = false) {
  if (!queue.length) return -1;
  if (repeatMode === "one" && !manual) return from;
  const order = playOrder();
  const pos = order.indexOf(from);
  // Walk forward skipping blocked tracks (they can't be played until unblocked).
  for (let step = pos + 1; step < order.length; step++) {
    if (!isBlocked(queue[order[step]])) return order[step];
  }
  if (repeatMode !== "off") {
    for (const idx of order) { if (idx !== from && !isBlocked(queue[idx])) return idx; }
  }
  return -1;
}
function updateNowPlaying(t, path) {
  setPlayIcon(true);
  $("#nowTitle").textContent = t ? t.title : (path || "").split("/").pop();
  $("#nowSub").textContent = t ? `${t.artist} — ${t.album}` : "";
  const art = $("#npArt");
  if (t) {
    setArtPlaceholder(art, t);
    if (S().showArt) {
      if (t.thumbnail) setArtImg(art, t.thumbnail);
      else { const cov = coverCache.get(albumKey(t)); if (cov) setArtImg(art, cov); else fetchCover(t); }
    }
  }
  const dur = t?.duration_secs || 0;
  $("#totTime").textContent = fmtDur(dur);
  const sk = $("#seek");
  sk.max = dur > 0 ? dur : 1; sk.value = 0; sk.style.setProperty("--fill", "0%");
  $("#curTime").textContent = "0:00"; _lastTimeTxt = "0:00";
  notifyTrack(t); mediaUpdate(t); renderNpPanel();
  // NB: Rich Presence is intentionally NOT updated here — updateNowPlaying runs
  // before the wall clock is re-anchored, so the RPC push happens at the real
  // playback start (hardPlay / gapless advance) with an explicit position of 0.
}
async function playFrom(viewIdx) { _drainSkips = 0; queue = view.map(t => t.path); history = []; if (shuffle) buildShuffle(viewIdx); await hardPlay(viewIdx); }
// If an online track was downloaded (file named "… [<id>].mp3"), play the local
// file instead of streaming from YouTube (Settings → "Prefer local file").
function effectivePath(path) {
  if (!path) return path;
  if (!isOnline(path)) return path;
  const local = localFileFor(path);
  return local || path;
}
async function startSource(cmd, path, gain) {
  // "remote:<key>" pseudo-paths stream a shared file from a paired device.
  if (String(path).startsWith("remote:")) {
    const t = _remote?.tracks.get(path) || onlineIndex.get(path);
    if (t?._remoteUrl) return invoke(cmd + "_direct", { url: t._remoteUrl, gain });
  }
  // Local files use play/preload; "yt:" pseudo-paths stream via yt-dlp resolution.
  if (isOnline(path)) return invoke(cmd + "_stream", { id: ytId(path), gain });
  return invoke(cmd, { path, gain });
}
let playSeq = 0; // guards against overlapping hardPlay calls (fast double-clicks)
async function hardPlay(i) {
  if (i < 0 || i >= queue.length) return;
  // Blocked track chosen directly (or reached): skip to the next playable one.
  if (isBlocked(queue[i])) {
    const j = nextIndex(i, true);
    if (j >= 0 && j !== i) return hardPlay(j);
    flash("That track is blocked — unblock it to play");
    return;
  }
  _needsStart = false; // a real playback start supersedes any pending resume
  const seq = ++playSeq;
  curIndex = i;
  const path = effectivePath(queue[i]);
  const t = trackByPath(path) || trackByPath(queue[i]);
  updateNowPlaying(t, path); updatePlayingRow(); // show metadata instantly
  if (isOnline(path)) {
    $("#nowSub").textContent += " · loading…";
    // Streams take a moment to resolve: silence the previous track right away
    // instead of letting it play over the "loading" state.
    try { const se = await invoke("stop"); curEpoch = Number(se) || curEpoch; } catch {}
    if (seq !== playSeq) return;
  }
  let e;
  try { e = await startSource("play", path, gainFor(t)); }
  catch (err) {
    if (seq !== playSeq) return; // a newer selection took over meanwhile
    try { const se = await invoke("stop"); curEpoch = Number(se) || curEpoch; } catch {}
    playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback();
    rpcStop(t); // playback stopped → drop the progress bar
    autoBlockUnplayableTrack(queue[i], String(err));
    const j = nextIndex(i, true);
    if (j >= 0 && j !== i) {
      hardPlay(j);
    }
    return;
  }
  if (seq !== playSeq) return; // superseded by a newer click
  curEpoch = Number(e) || 0;
  playing = true; wallStart(0); updatePlayingRow();
  rpcTrack(t);            // fresh track → progress bar at 0 (honours rpcDelay)
  recordHistory(t, queue[i]);
  savePlayback();
  if (t) $("#nowSub").textContent = `${t.artist} — ${t.album}`;
  mediaPlayback();
  // Optionally cache a streamed shared track to the local library as it plays.
  if (_remote?.saveLocal && String(path).startsWith("remote:")) shareSaveRemote(t);
  await schedulePreload();
}
async function schedulePreload() {
  const j = S().preloadNext ? nextIndex(curIndex) : -1;
  queueSettled = false;
  if (j >= 0 && j !== curIndex) {
    preIndex = j; expectedQueued = 2;
    const path = effectivePath(queue[j]);
    const t = trackByPath(path) || trackByPath(queue[j]);
    try { await startSource("preload", path, gainFor(t)); }
    catch (e) {
      // Preload failed (e.g. stream resolve error): expect only the current
      // track in the sink, so end-of-track recovery can kick in instead of
      // waiting forever for a second entry that will never arrive.
      console.warn("[preload]", e);
      preIndex = -1; expectedQueued = 1;
    }
  }
  else { preIndex = -1; expectedQueued = 1; }
}
async function togglePlay() {
  if (curIndex < 0 && view.length) return playFrom(0);
  if (_needsStart && !playing) {
    // First Play after a session-resume: actually start the restored track and
    // jump to where we left off.
    const pos = _resumePos; _needsStart = false;
    await hardPlay(curIndex);
    if (pos > 1) { try { await invoke("seek", { secs: pos }); wallSeek(pos); } catch {} }
    return;
  }
  const cur = trackByPath(queue[curIndex]);
  if (playing) {
    await invoke("pause"); playing = false; wallPause(); setPlayIcon(false); savePlayback(); rpcPause(cur);
    // Snap the frozen wall clock onto the engine's REAL position (they drift
    // during stream connects) so the bar shows the true paused spot instead of
    // jumping when playback resumes.
    try {
      const st = await invoke("status");
      if (st && (st.epoch || 0) === curEpoch && st.position > 0 && Math.abs(st.position - wallPos()) > 0.4) { wallSeek(st.position); renderSeek(st.position); }
    } catch {}
  }
  else { await invoke("resume"); playing = true; wallResume(); setPlayIcon(true); rpcResume(cur); }
  updatePlayingRow(); mediaPlayback();
}
async function next() { const j = nextIndex(curIndex, true); if (j < 0) { playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback(); rpcStop(trackByPath(queue[curIndex])); return; } history.push(curIndex); await hardPlay(j); }
async function prev() {
  if (wallPos() > 3) { await invoke("seek", { secs: 0 }); wallSeek(0); return; }
  if (history.length) await hardPlay(history.pop());
  else if (curIndex > 0) await hardPlay(curIndex - 1);
  else { await invoke("seek", { secs: 0 }); wallSeek(0); }
}
// Smooth 60fps progress bar (fill % + time). Runs paused too — the wall clock
// is frozen then, so the writes below no-op via the value guard, but external
// position changes (seek from the media widget, engine re-sync on pause) still
// repaint the bar instead of leaving a stale fill behind the thumb.
let _lastTimeTxt = "", _lastSeekVal = -1;
function renderSeek(p) {
  const el = $("#seek");
  el.value = p;
  const max = Number(el.max) || 1;
  el.style.setProperty("--fill", `${Math.min(100, (p / max) * 100).toFixed(2)}%`);
  const txt = fmtDur(p);
  if (txt !== _lastTimeTxt) { _lastTimeTxt = txt; $("#curTime").textContent = txt; }
  _lastSeekVal = p;
}
function startProgressLoop() {
  const loop = () => {
    if (!seeking && curIndex >= 0 && !document.hidden) {
      const p = wallPos();
      if (Math.abs(p - _lastSeekVal) > 0.05) renderSeek(p);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

let _posTick = 0;
let _lastAudioErr = "";
let _drainSkips = 0; // consecutive instant-drain auto-advances (failing streams)
function startPolling() {
  setInterval(async () => {
    // Surface silent audio failures (no output device, undecodable stream) so
    // "no sound" isn't a mystery — the #1 Android symptom.
    try {
      const ae = await invoke("audio_error");
      if (ae && ae !== _lastAudioErr) { _lastAudioErr = ae; flash("Audio: " + ae); console.error("[audio]", ae); }
    } catch {}
    // Paused or idle: nothing can change on its own — poll nothing (CPU).
    if (curIndex < 0 || !playing) return;
    if (++_posTick % 4 === 0) mediaPlayback(); // ~1.2s: keep the desktop widget's position fresh
    if (_posTick % 14 === 0) savePlayback();   // ~4s: persist resume point while playing
    const st = await invoke("status"); if (!st) return;
    if ((st.epoch || 0) !== curEpoch) return; // stale: previous sink still up while a play/stream starts
    // Re-anchor the wall clock on the engine's real position when they drift
    // (stream connect latency etc.) — kills progress-bar jumps.
    if (queueSettled && st.position > 0.5 && Math.abs(st.position - wallPos()) > 1.5) wallSeek(st.position);
    const queued = st.queued || 0;
    if (!queueSettled) {
      if (queued >= expectedQueued) queueSettled = true;
      else if (queued > 0) return; // still filling up
      // queued === 0 while never settled: the preload silently failed and the
      // current track already ended — fall through to end-of-track recovery.
    }
    if (queueSettled && queued < expectedQueued && queued >= 1 && preIndex >= 0) {
      history.push(curIndex); curIndex = preIndex;
      const t = trackByPath(effectivePath(queue[curIndex])) || trackByPath(queue[curIndex]);
      wallStart(0); updateNowPlaying(t, queue[curIndex]); updatePlayingRow(); mediaPlayback();
      rpcTrack(t); recordHistory(t, queue[curIndex]); savePlayback(); // gapless advance
      await schedulePreload();
    } else if (queued === 0 && playing) {
      // Sink drained: end of queue — or the stream failed to open (e.g. a 403
      // the re-resolver couldn't recover). A real end-of-track means the track
      // actually played; an instant drain with no progress means the stream
      // failed. Recover to the next track, but DON'T cascade through the whole
      // library when every stream is failing — stop after a few dry skips.
      const playedReal = wallPos() > 1.2 || (st.position || 0) > 1.2;
      if (playedReal) _drainSkips = 0;
      const j = nextIndex(curIndex);
      if (j >= 0 && _drainSkips < 4) {
        if (!playedReal) _drainSkips++;
        // First dry drain: retry THE SAME track once with a fresh stream —
        // exactly what pause-then-resume used to fix by hand (the skip landed
        // on a stream that failed to open). Only then give up and advance.
        if (!playedReal && _drainSkips === 1) { await hardPlay(curIndex); }
        else {
          if (!playedReal) autoBlockUnplayableTrack(queue[curIndex], "unplayable stream");
          history.push(curIndex); await hardPlay(j);
        }
      } else if (j >= 0) {
        playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback();
        _drainSkips = 0;
        flash("Playback keeps failing (stream errors) — stopped. Try again in a moment.");
      } else { playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback(); rpcStop(trackByPath(queue[curIndex])); } // queue drained → clear the progress bar
    }
  }, 300);
}

// ─── Smooth wheel scrolling (Performance → Smooth scrolling + intensity) ───
// CSS scroll-behavior only eases programmatic/keyboard scrolls, never the mouse
// wheel — which is why it "didn't work". So we animate the wheel ourselves:
// accumulate a target offset per container and lerp its scrollTop toward it each
// frame. smoothStrength (1..5) sets both the wheel step and the glide length.
// This handler also LOCKS the background: while a modal is open, a wheel over
// anything not inside it is swallowed so the library/playlists don't scroll.
const _sm = { el: null, target: 0, ease: 0.18, raf: 0 };
function scrollableFrom(node) {
  let el = node;
  while (el && el.nodeType === 1 && el !== document.body) {
    if (el.scrollHeight - el.clientHeight > 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
    }
    el = el.parentElement;
  }
  return null;
}
function _smStep() {
  _sm.raf = 0;
  const el = _sm.el;
  if (!el) return;
  const diff = _sm.target - el.scrollTop;
  if (Math.abs(diff) < 0.5) { el.scrollTop = _sm.target; return; }
  el.scrollTop += diff * _sm.ease;
  _sm.raf = requestAnimationFrame(_smStep);
}
function onWheelSmooth(e) {
  if (e.ctrlKey || e.defaultPrevented) return; // let pinch-zoom through
  const el = scrollableFrom(e.target);
  // Modal open → block the background from scrolling behind it.
  const modal = document.querySelector(".modal-backdrop:not([hidden])");
  if (modal && (!el || !modal.contains(el))) { e.preventDefault(); return; }
  if (!S().smoothScroll || !el) return; // native scroll when smoothing is off
  let delta = e.deltaY;
  if (!delta) return; // horizontal / no-op wheels pass through
  if (e.deltaMode === 1) delta *= 16;             // lines → px
  else if (e.deltaMode === 2) delta *= el.clientHeight; // pages → px
  const strength = Math.min(5, Math.max(1, S().smoothStrength ?? 3));
  const step = 0.7 + strength * 0.28;         // 0.98 … 2.1 wheel-distance multiplier
  _sm.ease = 0.34 - (strength - 1) * 0.04;    // 0.34 (snappy) … 0.18 (glide) — never sluggish
  e.preventDefault();
  // Re-seed the target on a fresh container or once the previous glide settled,
  // so scrollbar drags / programmatic jumps don't fight the animation.
  if (_sm.el !== el || !_sm.raf || Math.abs(_sm.target - el.scrollTop) > 150) { _sm.el = el; _sm.target = el.scrollTop; }
  const max = el.scrollHeight - el.clientHeight;
  _sm.target = Math.max(0, Math.min(max, _sm.target + delta * step));
  if (!_sm.raf) _sm.raf = requestAnimationFrame(_smStep);
}
function initSmoothScroll() {
  window.addEventListener("wheel", onWheelSmooth, { passive: false });
}

// ─── Interface arrangement: hide/collapse sections, dock the up-next panel ───
function applyUiPrefs() {
  const s = S();
  $("#navHistory").hidden = !(Number(s.historyLimit) > 0);
  // Sources now live in a topbar dropdown — hiding the section hides its button.
  const srcWrap = document.querySelector(".top-drop-wrap");
  if (srcWrap) srcWrap.hidden = !s.uiSources;
  $("#pickBtn").hidden = !s.uiSrcButtons;
  $("#manualBtn").hidden = !s.uiSrcButtons;
  $("#secPlaylists").hidden = !s.uiPlaylists;
  $("#importBtn").hidden = !s.uiImportBtn;
  // Hide the whole row, not just the select: the sort icon lives beside it now,
  // so hiding the select alone would leave a stray icon on an empty strip.
  // Derive the inline display from the column headers so toggling the setting
  // applies at once without waiting for the next render, and without showing
  // the row on views that have no track list.
  $("#sortSel").hidden = !s.uiSortSel;
  const lt = $("#listTools");
  if (lt) {
    lt.hidden = !s.uiSortSel;
    lt.style.display = (!s.uiSortSel || $("#listHead").style.display === "none") ? "none" : "";
  }
  $("#secPlaylists").classList.toggle("collapsed", !!s.collPlaylists);
  document.body.classList.toggle("np-docked", !!s.npDocked);
  $("#npPin").classList.toggle("active", !!s.npDocked);
}

// ─── Now Playing panel: big artwork + track info + up-next queue ───
let npOpen = false;
// Push vs float is decided from the REAL width left over next to the drawer —
// not from a CSS breakpoint (those are in CSS px and lied under Windows
// display scaling, leaving the drawer glued over the content). Whenever the
// sidebar + a usable track list still fit (~430px), the whole app shrinks
// around the drawer; only truly narrow windows keep the phone-style overlay.
function updateNpPush() {
  const eff = Math.min(Number(S().npW) || 330, Math.max(window.innerWidth * 0.34, 260));
  // ≥700px matches the phone-overlay CSS breakpoint: below it the class would
  // be set only for the stylesheet to neutralize it — don't set it at all.
  document.body.classList.toggle("np-push", npOpen && window.innerWidth >= 700 && window.innerWidth - eff >= 430);
}
function toggleNpPanel(force) {
  npOpen = force !== undefined ? force : !npOpen;
  if (npOpen && dlOpen) { dlOpen = false; dlRender(); }
  $("#npPanel").hidden = !npOpen;
  document.body.classList.toggle("np-open", npOpen);
  updateNpPush();
  SETTINGS.setSetting("uiNpOpen", npOpen);
  if (npOpen) renderNpPanel();
}
window.addEventListener("resize", updateNpPush);
function renderNpPanel() {
  if (!npOpen) return;
  const path = curIndex >= 0 ? queue[curIndex] : null;
  const eff = path ? effectivePath(path) : null;
  const t = path ? (trackByPath(eff) || trackByPath(path)) : null;
  const art = $("#ovArt");
  if (t) {
    setArtPlaceholder(art, t);
    if (S().showArt) {
      if (t.thumbnail) setArtImg(art, t.thumbnail);
      else { const cov = coverCache.get(albumKey(t)); if (cov) setArtImg(art, cov); else fetchCover(t); }
    }
    $("#ovTitle").textContent = t.title;
    $("#ovSub").textContent = t.artist;
    $("#ovMeta").textContent = `${t.album}${t.duration_secs ? ` · ${fmtDur(t.duration_secs)}` : ""} · ${isOnline(eff) ? "streaming" : "local file"}`;
  } else {
    art.classList.remove("has-cover"); art.style.backgroundImage = ""; art.style.background = "var(--bg-3)"; art.innerHTML = IC.music;
    $("#ovTitle").textContent = "Nothing playing"; $("#ovSub").textContent = ""; $("#ovMeta").textContent = "";
  }
  // Up next — same list for sequential AND shuffle (pre-computed order).
  const items = upcomingIndexes(25).map(qi => ({ qi }));
  if (curIndex >= 0 && queue.length) {
    if (repeatMode === "one") items.push({ note: "Repeat one — this track loops" });
    else if (!items.length) items.push({ note: "End of queue" });
    else if (shuffle) items.push({ note: "Shuffled order" });
  }
  const host = $("#upNextList");
  host.innerHTML = items.length
    ? items.map(it => {
        if (it.note) return `<div class="nx-note">${it.note}</div>`;
        const p = queue[it.qi];
        const tr = trackByPath(effectivePath(p)) || trackByPath(p);
        if (!tr) return "";
        return `<div class="nx-row" data-qi="${it.qi}" title="${esc(tr.title)}">${artCell(tr)}
          <span class="nx-meta"><span class="t">${esc(tr.title)}</span><span class="s">${esc(tr.artist)}</span></span>
          <span class="nx-dur">${fmtDur(tr.duration_secs)}</span></div>`;
      }).join("")
    : `<div class="nx-note">Queue is empty — play something.</div>`;
  host.querySelectorAll("[data-qi]").forEach(el => {
    el.addEventListener("click", () => { history.push(curIndex); hardPlay(Number(el.dataset.qi)); });
    // Up-next rows get the standard track menu too — same as a playlist row.
    el.addEventListener("contextmenu", (e) => {
      const p = queue[Number(el.dataset.qi)];
      if (!p) return;
      e.preventDefault();
      selected.clear(); selected.add(p);
      anchorIdx = view.findIndex(t => t.path === p);
      refreshSelectionUI();
      openContextMenu(e.clientX, e.clientY);
    });
  });
}

// ─── Desktop media integration (MPRIS) ───
// Pushes track + playback state to the OS so KDE/GNOME widgets, playerctl and
// media keys see the player; their commands come back as "media" events.
async function mediaUpdate(t) {
  if (!IS_NATIVE || !t) return;
  try {
    await invoke("media_update", {
      title: t.title || "", artist: t.artist || "", album: t.album || "",
      art: t.thumbnail || "", durationSecs: t.duration_secs || 0,
    });
  } catch (e) { console.error("[mpris meta]", e); }
}
async function mediaPlayback() {
  if (!IS_NATIVE || curIndex < 0) return;
  try { await invoke("media_playback", { playing, positionSecs: wallPos() }); }
  catch (e) { console.error("[mpris state]", e); }
}
function listenDlEvents() {
  if (!IS_NATIVE || !T.event?.listen) return;
  T.event.listen("dl", ({ payload }) => {
    try { const { id, pct } = typeof payload === "string" ? JSON.parse(payload) : payload; dlProgress(id, Number(pct) || 0); }
    catch {}
  }).catch(e => console.error("[dl listen]", e));
  // APK self-update download progress (Android in-app updater).
  T.event.listen("apkdl", ({ payload }) => {
    try {
      const pct = Number((typeof payload === "string" ? JSON.parse(payload) : payload).pct) || 0;
      if (_apkTask) taskUpdate(_apkTask, { pct, detail: `downloading APK… ${pct}%` });
    } catch {}
  }).catch(() => {});
}
let _apkTask = null;

function listenMediaEvents() {
  if (!IS_NATIVE || !T.event?.listen) return;
  T.event.listen("media", async ({ payload }) => {
    const msg = String(payload || "");
    if (msg === "toggle") return togglePlay();
    if (msg === "play") { if (!playing) togglePlay(); return; }
    if (msg === "pause") { if (playing) togglePlay(); return; }
    if (msg === "next") return next();
    if (msg === "previous") return prev();
    if (msg.startsWith("position:")) {
      const s = Math.max(0, Number(msg.slice(9)) || 0);
      await invoke("seek", { secs: s }); wallSeek(s);
      renderSeek(s); mediaPlayback();
      return;
    }
    if (msg.startsWith("seekby:")) {
      const d = Number(msg.slice(7)) || 0;
      const s = Math.max(0, wallPos() + d);
      await invoke("seek", { secs: s }); wallSeek(s);
      renderSeek(s); mediaPlayback();
    }
  }).catch(e => console.error("[mpris listen]", e));
}

// ─── Notifications + Rich Presence ───
let _notifChecked = false, _notifGranted = false;
async function ensureNotifPerm() {
  if (_notifChecked) return _notifGranted;
  try {
    _notifGranted = await T.core.invoke("plugin:notification|is_permission_granted");
    if (!_notifGranted) { const r = await T.core.invoke("plugin:notification|request_permission"); _notifGranted = r === "granted"; }
  } catch (e) { console.error("[notif perm]", e); _notifGranted = false; }
  _notifChecked = true; return _notifGranted;
}
async function notifyTrack(t) {
  if (!IS_NATIVE || !S().notifyOnChange || !t) return;
  if (!(await ensureNotifPerm())) return;
  try { await T.core.invoke("plugin:notification|notify", { options: { title: t.title, body: `${t.artist} — ${t.album}` } }); }
  catch (e) { console.error("[notify]", e); }
}
// posOverride: pass 0 when a track has just started so Discord's progress bar
// resets to the beginning — relying on wallPos() there is wrong because the wall
// clock isn't re-anchored (wallStart(0)) until playback is actually confirmed,
// so it would still report the PREVIOUS track's elapsed time.
async function updateRPC(t, isPlaying, posOverride) {
  if (!IS_NATIVE || !S().rpcEnabled || !S().rpcClientId) return;
  try {
    await invoke("rpc_update", {
      clientId: S().rpcClientId, title: t?.title || "", artist: t?.artist || "", playing: !!isPlaying,
      art: t?.thumbnail || "", durationSecs: t?.duration_secs || 0,
      positionSecs: posOverride != null ? posOverride : wallPos(),
    });
  } catch (e) { console.error("[rpc]", e); }
}
async function clearRPC() { if (IS_NATIVE) { try { await invoke("rpc_clear"); } catch {} } }

// Discord RPC policy layer (Settings → Discord Rich Presence):
//  • rpcDelay: wait N s before showing a NEW track — skipping quickly through
//    several tracks won't spam Discord ("titles apart" effect: only what you
//    settle on shows).  • rpcPauseClear: N s after pausing, remove the presence
//    entirely (0 = immediately). On resume the presence comes back at once.
let _rpcDelayTimer = null, _rpcPauseTimer = null;
function _rpcClearTimers() { clearTimeout(_rpcDelayTimer); clearTimeout(_rpcPauseTimer); _rpcDelayTimer = _rpcPauseTimer = null; }
function rpcTrack(t) { // a new track just started playing
  clearTimeout(_rpcPauseTimer); _rpcPauseTimer = null;
  clearTimeout(_rpcDelayTimer);
  const delay = Math.max(0, Number(S().rpcDelay) || 0) * 1000;
  if (!delay) { updateRPC(t, true, 0); return; }
  _rpcDelayTimer = setTimeout(() => { if (playing && curIndex >= 0) updateRPC(t, true, 0); }, delay);
}
function rpcResume(t) { clearTimeout(_rpcPauseTimer); _rpcPauseTimer = null; updateRPC(t, true); }
function rpcPause(t) {
  clearTimeout(_rpcDelayTimer);
  const secs = Math.max(0, Number(S().rpcPauseClear) || 0);
  if (secs <= 0) { _rpcClearTimers(); clearRPC(); return; } // remove presence at once
  // Push the paused state RIGHT NOW: without this the last "playing" activity
  // (with live timestamps) stays up and Discord's counter keeps running.
  updateRPC(t, false);
  clearTimeout(_rpcPauseTimer);
  _rpcPauseTimer = setTimeout(() => { if (!playing) clearRPC(); }, secs * 1000); // …then remove it
}
// Playback fully stopped (queue drained / explicit stop): remove the presence —
// a stale "Paused — <last track>" card lingering forever is worse than nothing.
function rpcStop() { _rpcClearTimers(); clearRPC(); }

// ─── Library (persisted) ───
async function saveLibrary() {
  // Last-line guard: never persist two entries for the same path, whatever
  // code path inserted them (keep the first = richest after enrich).
  if (library.length) {
    const m = new Map();
    for (const t of library) if (!m.has(t.path)) m.set(t.path, t);
    if (m.size !== library.length) { console.warn(`[library] dropped ${library.length - m.size} duplicate entries`); library = [...m.values()]; }
  }
  enrichLibrary();
  await storeSave("library", JSON.stringify({ folders, tracks: library }));
}
async function loadLibrary() {
  const raw = await storeLoad("library");
  if (raw) { try { const d = JSON.parse(raw); folders = Array.isArray(d.folders) ? d.folders : []; library = Array.isArray(d.tracks) ? d.tracks : []; } catch {} }
}
// Heal path aliasing: the SAME file reached through two spellings gives two
// entries — every track shows up twice. Sources of aliases seen in the wild:
// symlinked folders (~/Desktop/music → ~/Data/music), /home vs /var/home
// (symlink on the host, two BIND MOUNTS inside the distrobox container — which
// plain prefix rewriting missed), pickers returning realpaths. So: canonicalize
// EVERY track path (one batch IPC call — the backend folds bind-mount aliases
// too), remap playlists in bulk, then drop the duplicates that collapse.
// Runs at every startup; a clean library is a fast no-op.
async function normalizeLibraryPaths() {
  if (!IS_NATIVE || !library.length) return;
  let changed = false;
  for (let i = 0; i < folders.length; i++) {
    try {
      const c = await invoke("canon_path", { path: folders[i] });
      if (c && c !== folders[i]) { folders[i] = c; changed = true; }
    } catch {}
  }
  const nf = [...new Set(folders)];
  if (nf.length !== folders.length) { folders = nf; changed = true; }
  try {
    const canon = await invoke("canon_paths", { paths: library.map(t => t.path) });
    if (Array.isArray(canon) && canon.length === library.length) {
      const remap = new Map();
      for (let i = 0; i < library.length; i++) {
        const np = canon[i];
        if (np && np !== library[i].path) { remap.set(library[i].path, np); library[i].path = np; changed = true; }
      }
      if (remap.size) PL.replaceMany(remap);
    }
  } catch (e) { console.error("[canon]", e); }
  const byP = new Map();
  for (const t of library) {
    const prev = byP.get(t.path);
    if (!prev) byP.set(t.path, t);
    else if (!prev.thumbnail && t.thumbnail) byP.set(t.path, t); // keep the richer entry
  }
  if (byP.size !== library.length) {
    flash(`Library cleaned — ${library.length - byP.size} duplicate entr${library.length - byP.size === 1 ? "y" : "ies"} merged`);
    library = [...byP.values()];
    changed = true;
  }
  if (changed) { await saveLibrary(); console.warn("[library] paths normalized / duplicates removed"); }
}
async function addSource(path) {
  if (!path) return;
  // Folder pickers can return an alias of an already-added source (symlinked
  // /home vs /var/home): canonicalize before comparing, or the same folder
  // gets scanned twice under two spellings and every track doubles.
  if (IS_NATIVE) { try { path = await invoke("canon_path", { path }); } catch {} }
  flash(`Scanning ${baseName(path)}…`);
  const tracks = await invoke("scan", { paths: [path] });
  const found = Array.isArray(tracks) ? tracks : [];
  const seen = new Set(library.map(t => t.path));
  library = library.concat(found.filter(t => !seen.has(t.path)));
  if (!folders.includes(path)) folders.push(path);
  await saveLibrary();
  renderSources();
  openSource(path);
  flash(`Added ${baseName(path)} · ${found.length} song${found.length === 1 ? "" : "s"}`);
}
async function rescanAll() {
  if (!folders.length) { flash("No sources to refresh"); return; }
  const list = [...folders];
  const tid = taskStart("Refreshing library", { detail: `${list.length} folder${list.length === 1 ? "" : "s"}`, pct: 0 });
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    taskUpdate(tid, { detail: baseName(list[i]), pct: (i / list.length) * 100 });
    total += await diffFolder(list[i]);
  }
  await saveLibrary(); renderSources();
  // Refresh the view only if the user is still looking at the library/source.
  if (active.type === "source") openSource(active.id);
  else if (active.type === "library") showLibrary();
  taskEnd(tid, { detail: total ? `${total} new song${total === 1 ? "" : "s"}` : "up to date", ttl: 6000 });
  flash(total ? `${total} new song${total === 1 ? "" : "s"} found` : "Library up to date");
}
async function pickFolder() {
  if (!IS_NATIVE) { const p = await askText("Add a folder", { placeholder: "Folder path" }); if (p) await addSource(p); return; }
  // Android has no system folder picker through the dialog plugin (it silently
  // returns nothing → the button "does nothing"). Ask for the path directly,
  // prefilled with the standard Music folder.
  if (IS_ANDROID) {
    const p = await askText("Add a folder", { placeholder: ANDROID_MUSIC_DIR, value: ANDROID_MUSIC_DIR });
    if (p) await addSource(p);
    return;
  }
  const btn = $("#pickBtn"); btn.disabled = true;
  try {
    const path = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose a music folder" } });
    if (path) await addSource(path);
  } catch (e) { console.error("[dialog]", e); const p = await askText("Add a folder", { placeholder: IS_ANDROID ? ANDROID_MUSIC_DIR : "Folder path" }); if (p) await addSource(p); }
  finally { btn.disabled = false; }
}
async function addManual() { const p = await askText("Add a folder", { placeholder: "/path/to/music" }); if (p) addSource(p); }

// ─── Settings ───
function applyAccent() {
  const [a, b] = SETTINGS.ACCENTS[S().accent] || SETTINGS.ACCENTS.violet;
  document.documentElement.style.setProperty("--accent", a);
  document.documentElement.style.setProperty("--accent-2", b);
}
let _bgCachePath = "", _bgCacheData = "";
function hexRgb(h) { h = String(h || "#000").replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0); }
function mixHex(hex, rgb, p) { const a = hexRgb(hex); return "#" + a.map((x, i) => Math.round(x + (rgb[i] - x) * p).toString(16).padStart(2, "0")).join(""); }
// "Custom" theme: three user colors, all shades derived.
function customTheme(s) {
  const W = [255, 255, 255];
  const panelRgb = hexRgb(s.customPanel);
  return {
    "--bg-0": s.customBg, "--bg-1": s.customPanel,
    "--bg-2": mixHex(s.customPanel, W, 0.05), "--bg-3": mixHex(s.customPanel, W, 0.10), "--bg-4": mixHex(s.customPanel, W, 0.17),
    "--tx-1": s.customText, "--tx-2": mixHex(s.customText, panelRgb, 0.38), "--tx-3": mixHex(s.customText, panelRgb, 0.62),
  };
}
async function applyTheme() {
  const s = S();
  const root = document.documentElement.style;
  const theme = s.theme === "custom" ? customTheme(s) : (SETTINGS.THEMES[s.theme] || SETTINGS.THEMES.dark);
  for (const [k, v] of Object.entries(theme)) root.setProperty(k, v);
  root.setProperty("--r", `${s.radius ?? 12}px`);
  root.setProperty("--topbar-pad", `${s.topbarPad ?? 13}px`);
  root.setProperty("--thumb-size", `${s.thumbSize ?? 12}px`);
  root.setProperty("--side-w", `${s.sideW ?? 268}px`);
  root.setProperty("--np-w", `${s.npW ?? 330}px`);
  document.body.classList.toggle("compact-top", !!s.compactTopbar);
  // Custom slider-thumb image (the "pink dot"). Resolved to a data URL for local
  // paths, like the wallpaper, and applied as a CSS var used by every range thumb.
  applyThumbImage(s);
  // CSS `zoom` shifts the coordinate space of position:fixed elements and vw
  // units on the Android WebView (content ends up offset / cut off — the
  // "dezoom" bug). Use it on desktop only; mobile keeps a 1:1 viewport.
  document.body.style.zoom = IS_ANDROID ? "" : String((s.uiScale ?? 100) / 100);
  applyAccent();
  root.setProperty("--app-bg-blur", `${s.bgBlur ?? 18}px`);
  root.setProperty("--app-bg-dim", String(s.bgDim ?? 45));
  root.setProperty("--panel-alpha", String(s.panelAlpha ?? 85));
  let src = (s.bgImage || "").trim();
  if (src && !/^(https?:|data:)/.test(src)) {
    // Local file path → data URL via the backend (cached per path).
    if (_bgCachePath !== src) {
      try { _bgCacheData = await invoke("read_image", { path: src }); _bgCachePath = src; }
      catch (e) { console.error("[bg]", e); _bgCacheData = ""; _bgCachePath = src; flash("Background image could not be loaded"); }
    }
    src = _bgCacheData;
  }
  root.setProperty("--app-bg-image", src ? `url("${src}")` : "none");
  document.body.classList.toggle("has-bg", !!src);
  // Text/panel scheme on top of the wallpaper. "light" here = light SCHEME =
  // dark text (used only when the background actually reads bright). Manual
  // modes force it; "auto" samples the image but must judge what the eye truly
  // sees BEHIND the text — i.e. the wallpaper after the dim overlay AND under
  // the translucent panels — not the raw pixels (that was the old bug: a mid
  // pink averaged near the threshold while the dimmed/paneled result was dark).
  let light = false;
  if (src) {
    if (s.bgTextMode === "light") light = false;      // light text (dark scheme)
    else if (s.bgTextMode === "dark") light = true;   // dark text (light scheme)
    else {
      // Effective luminance the eye sees behind panel text: the dark panel
      // (#0a0a0f ≈ 0.04) drawn at panel-alpha over the wallpaper, which the dim
      // overlay has already darkened (brightness = 1 − dim). Sampling the raw
      // image ignored both and mis-picked the scheme on mid-tone wallpapers.
      const raw = await probeLuma(src);
      const dim = Math.min(1, Math.max(0, (s.bgDim ?? 45) / 100));
      const alpha = Math.min(1, Math.max(0, (s.panelAlpha ?? 85) / 100));
      const eff = alpha * 0.04 + (1 - alpha) * (raw * (1 - dim));
      light = eff > 0.5;
    }
  }
  document.body.classList.toggle("bg-light", !!src && light);
}
const _lumaCache = new Map();
function probeLuma(src) {
  if (_lumaCache.has(src)) return Promise.resolve(_lumaCache.get(src));
  return new Promise(res => {
    const done = v => { _lumaCache.set(src, v); res(v); };
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 12;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let l = 0;
        for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        done(l / (d.length / 4) / 255);
      } catch { done(0.2); } // cross-origin: assume dark
    };
    img.onerror = () => done(0.2);
    img.src = src;
  });
}
let _thumbCache = { path: "", data: "" };
async function applyThumbImage(s) {
  const root = document.documentElement.style;
  let src = (s.sliderImage || "").trim();
  if (src && !/^(https?:|data:)/.test(src)) {
    if (_thumbCache.path !== src) {
      try { _thumbCache.data = await invoke("read_image", { path: src }); _thumbCache.path = src; }
      catch { _thumbCache.data = ""; _thumbCache.path = src; }
    }
    src = _thumbCache.data;
  }
  root.setProperty("--thumb-img", src ? `url("${src}")` : "none");
  document.body.classList.toggle("has-thumb", !!src);
}
function applySettings() {
  applyTheme();
  applyUiPrefs();
  document.body.classList.toggle("compact", S().compactRows);
  document.body.classList.toggle("no-anim", !S().animations);
  document.body.classList.toggle("smooth", S().smoothScroll);
  normalize = S().normalizeDefault;
  invoke("set_agc", { on: normalize }).catch(() => {});
  shuffle = S().shuffleDefault; $("#shuffleBtn").classList.toggle("active", shuffle);
  repeatMode = ["off", "all", "one"].includes(S().repeatDefault) ? S().repeatDefault : "off";
  updateRepeatBtn();
  const v = S().defaultVolume; $("#volume").value = v; $("#volume").style.setProperty("--fill", `${v}%`); invoke("set_volume", { level: v / 100 });
}
// Version switcher / downgrade (Settings → System → Updates). Lists the version
// commits from local git and, on Build, checks one out + rebuilds + restarts.
async function initVersionSwitcher() {
  const sel = $("#setVerSel"), go = $("#setVerGo"), hint = $("#setVerHint");
  const row = $("#setVerRow");
  // Git-based version switching only makes sense with a local source tree
  // (desktop dev). On installers / Android it's meaningless → keep it hidden.
  if (!sel || !IS_NATIVE || IS_ANDROID) return;
  let list = [];
  try { list = await invoke("list_versions"); }
  catch { return; } // no source tree → leave the switcher hidden
  if (!Array.isArray(list) || !list.length) return;
  if (row) row.hidden = false;
  if (hint) hint.hidden = false;
  sel.innerHTML = list.map(v => `<option value="${v.hash}" ${v.current ? "selected" : ""}>${esc(v.version)}${v.current ? " — current" : ""} · ${esc(v.date)}</option>`).join("");
  const sync = () => { const cur = list.find(v => v.hash === sel.value); go.disabled = !sel.value || (cur && cur.current); };
  sync();
  sel.onchange = sync;
  go.onclick = async () => {
    const v = list.find(x => x.hash === sel.value); if (!v) return;
    if (!await askConfirm(`Switch to ${v.version}?`, "The app rebuilds at that version and restarts. Your library, playlists and settings are kept.", "Build & switch")) return;
    go.disabled = true; hint.textContent = `Building ${v.version}… this can take a minute.`;
    try {
      await invoke("switch_version", { rev: v.hash });
      hint.textContent = `Built ${v.version} — restarting…`;
      setTimeout(() => invoke("restart_app").catch(() => {}), 600);
    } catch (e) { hint.textContent = String(e); go.disabled = false; flash(`Switch failed: ${e}`); }
  };
}
function openSettings() {
  const s = S();
  $("#settingsBody").innerHTML = `
    <nav class="set-nav">
      <button class="set-tab on" data-tab="appearance">${ic(IC.image)}<span>Appearance</span></button>
      <button class="set-tab" data-tab="interface">${ic(IC.list)}<span>Interface</span></button>
      <button class="set-tab" data-tab="playback">${ic(IC.play)}<span>Playback</span></button>
      <button class="set-tab" data-tab="youtube">${ic(IC.globe)}<span>YouTube</span></button>
      <button class="set-tab" data-tab="downloads">${ic(IC.dl)}<span>Downloads</span></button>
      <button class="set-tab" data-tab="integrations">${ic(IC.radio)}<span>Integrations</span></button>
      <button class="set-tab" data-tab="library">${ic(IC.note)}<span>Library</span></button>
      <button class="set-tab" data-tab="system">${ic(IC.gear)}<span>System</span></button>
    </nav>
    <div class="set-panes">
    <section class="set-pane on" data-pane="appearance">
    <div class="set-group"><div class="set-title">Theme</div>
      <div class="set-row"><label>Theme</label>
        <select id="setTheme" class="sel sm-sel wide">${Object.keys(SETTINGS.THEMES).map(k => `<option value="${k}" ${s.theme === k ? "selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}<option value="custom" ${s.theme === "custom" ? "selected" : ""}>Custom</option></select></div>
      <div class="set-row"><label>Custom colors <span class="set-sub">(background · panels · text)</span></label>
        <span class="color-row">
          <input type="color" id="setCustBg" value="${s.customBg}" title="Window background">
          <input type="color" id="setCustPanel" value="${s.customPanel}" title="Panels">
          <input type="color" id="setCustText" value="${s.customText}" title="Text">
        </span></div>
      <div class="set-row"><label>Corner radius</label><input type="range" id="setRadius" min="0" max="22" value="${s.radius}"></div>
      <div class="set-row"><label>UI scale</label><input type="range" id="setScale" min="85" max="125" value="${s.uiScale}"></div>
      <div class="set-row"><label>Accent color</label>
        <div class="swatches">${Object.entries(SETTINGS.ACCENTS).map(([k, v]) => `<button class="swatch ${s.accent === k ? "on" : ""}" data-accent="${k}" style="background:${v[0]};color:${v[0]}" title="${k}"></button>`).join("")}</div></div>
      <div class="set-row"><label>Background image</label>
        <span class="dir-pick">
          <input type="text" id="setBgImg" class="text-in" placeholder="none — URL or file" value="${esc(s.bgImage)}">
          <button id="setBgPick" class="btn-line sm" title="Pick an image">${ic(IC.image)}</button>
          <button id="setBgClear" class="btn-line sm" title="Remove background">${IC.x}</button>
        </span></div>
      <div class="set-row"><label>Background blur</label><input type="range" id="setBgBlur" min="0" max="40" value="${s.bgBlur}"></div>
      <div class="set-row"><label>Background darkness</label><input type="range" id="setBgDim" min="0" max="90" value="${s.bgDim}"></div>
      <div class="set-row"><label>Text on wallpaper</label>
        <select id="setBgText" class="sel sm-sel wide">
          <option value="auto" ${s.bgTextMode === "auto" ? "selected" : ""}>Auto (detect)</option>
          <option value="light" ${s.bgTextMode === "light" ? "selected" : ""}>Light text</option>
          <option value="dark" ${s.bgTextMode === "dark" ? "selected" : ""}>Dark text</option>
        </select></div>
      <div class="set-row"><label>Panel opacity</label><input type="range" id="setPanelA" min="35" max="100" value="${s.panelAlpha}"></div>
      <div class="set-hint">Blur / darkness / opacity apply live when a background image is set — mix them with any theme + accent.</div>
    </div>
    <div class="set-group"><div class="set-title">Top bar &amp; sliders</div>
      <div class="set-row"><label>Compact top bar</label><input type="checkbox" id="setCompactTop" ${s.compactTopbar ? "checked" : ""}></div>
      <div class="set-row"><label>Top bar height</label><input type="range" id="setTopPad" min="4" max="22" value="${s.topbarPad ?? 13}"></div>
      <div class="set-row"><label>Slider knob size</label><input type="range" id="setThumbSize" min="8" max="28" value="${s.thumbSize ?? 12}"></div>
      <div class="set-row"><label>Slider knob image <span class="set-sub">(the “dot” on volume / seek)</span></label>
        <span class="dir-pick">
          <input type="text" id="setThumbImg" class="text-in" placeholder="none — URL or file" value="${esc(s.sliderImage)}">
          <button id="setThumbPick" class="btn-line sm" title="Pick an image">${ic(IC.image)}</button>
          <button id="setThumbClear" class="btn-line sm" title="Remove">${IC.x}</button>
        </span></div>
      <div class="set-hint">Put any image on the slider knob — a face, a logo, an emoji screenshot… Square images look best.</div>
    </div>
    </section>
    <section class="set-pane" data-pane="interface">
    <div class="set-group"><div class="set-title">Interface</div>
      <div class="set-row"><label>Sources section</label><input type="checkbox" id="setUiSources" ${s.uiSources ? "checked" : ""}></div>
      <div class="set-row"><label>“Add folder” buttons</label><input type="checkbox" id="setUiSrcBtns" ${s.uiSrcButtons ? "checked" : ""}></div>
      <div class="set-row"><label>Playlists section</label><input type="checkbox" id="setUiPlaylists" ${s.uiPlaylists ? "checked" : ""}></div>
      <div class="set-row"><label>“YouTube playlists” button</label><input type="checkbox" id="setUiImport" ${s.uiImportBtn ? "checked" : ""}></div>
      <div class="set-row"><label>Sort selector</label><input type="checkbox" id="setUiSort" ${s.uiSortSel ? "checked" : ""}></div>
      <div class="set-row"><label>Dock the “Now playing / Up next” panel</label><input type="checkbox" id="setUiDock" ${s.npDocked ? "checked" : ""}></div>
      <div class="set-hint">Tip: the sidebar section titles (Sources / Playlists) collapse on click, and the dock button in the “Now playing” panel docks it as a side column.</div>
    </div>
    <div class="set-group"><div class="set-title">Performance</div>
      <div class="set-hint">Turn these off on a slower machine or to save battery — the app stays fully functional.</div>
      <div class="set-row"><label>Smooth scrolling</label><input type="checkbox" id="setSmooth" ${s.smoothScroll ? "checked" : ""}></div>
      <div class="set-row"><label>Smooth intensity <span class="set-sub">(subtle → long glide)</span></label><input type="range" id="setSmoothAmt" min="1" max="5" step="1" value="${s.smoothStrength ?? 3}"></div>
      <div class="set-row"><label>Interface animations</label><input type="checkbox" id="setAnim" ${s.animations ? "checked" : ""}></div>
      <div class="set-row"><label>Album artwork</label><input type="checkbox" id="setArt" ${s.showArt ? "checked" : ""}></div>
      <div class="set-row"><label>Compact rows (denser lists)</label><input type="checkbox" id="setCompact" ${s.compactRows ? "checked" : ""}></div>
      <div class="set-row"><label>Preload next track (gapless)</label><input type="checkbox" id="setPreload" ${s.preloadNext ? "checked" : ""}></div>
    </div>
    </section>
    <section class="set-pane" data-pane="playback">
    <div class="set-group"><div class="set-title">Playback</div>
      <div class="set-row"><label>Default volume</label><input type="range" id="setVol" min="0" max="100" value="${s.defaultVolume}"></div>
      <div class="set-row"><label>Keep all tracks at the same volume</label><input type="checkbox" id="setNorm" ${s.normalizeDefault ? "checked" : ""}></div>
      <div class="set-hint">Automatic gain control evens out quiet/loud tracks (works for streams and YouTube mp3s without tags). Applies from the next track.</div>
      <div class="set-row"><label>Shuffle by default</label><input type="checkbox" id="setShuf" ${s.shuffleDefault ? "checked" : ""}></div>
      <div class="set-row"><label>Resume where I left off</label><input type="checkbox" id="setResume" ${s.resumePlayback ? "checked" : ""}></div>
      <div class="set-hint">On launch, reopen the last track paused at the spot you stopped — press play to continue.</div>
      <div class="set-row"><label>Keep a listening history <span class="set-sub">(0 = off · up to 1000)</span></label><input type="number" id="setHist" class="num-in" min="0" max="1000" step="10" value="${s.historyLimit ?? 50}"></div>
      <div class="set-hint">Recently played tracks appear in the <b>Recently played</b> tab in the sidebar.</div>
    </div>
    </section>
    <section class="set-pane" data-pane="youtube">
    <div class="set-group"><div class="set-title">YouTube</div>
      <div class="set-hint" style="margin-bottom:10px">Search, streaming and downloads work out of the box through a <b>built-in engine</b> — no setup needed.${IS_ANDROID ? "" : " yt-dlp below is an <b>optional</b> desktop booster (used first when present)."}</div>
      ${IS_ANDROID ? "" : `<div class="set-row"><label>yt-dlp binary</label>
        <span class="dir-pick">
          <input type="text" id="setYtPath" class="text-in" placeholder="auto-detect" value="${esc(s.ytdlpPath)}">
          <button id="setYtPick" class="btn-line sm" title="Pick the binary">${ic(IC.folder)}</button>
          <button id="setYtTest" class="btn-line sm" title="Test">Test</button>
          <button id="setYtInstall" class="btn-line sm" title="Download yt-dlp automatically">${ic(IC.upload)}Install</button>
        </span></div>
      <div class="set-hint" id="setYtStatus">Empty = auto-detect (PATH, Desktop folders, external drives, linuxbrew). Missing? Click <b>Install</b> to download it.</div>`}
      ${IS_ANDROID
        ? `<div class="set-hint">⚠️ <b>Account risk:</b> using your logged-in YouTube session for downloads is more traceable and often makes YouTube <b>block</b> extraction. The built-in engine works without it — browser cookies are a desktop-only option, so they're disabled here.</div>`
        : `<div class="set-row"><label>Cookies from browser</label>
        <select id="setCookies" class="sel sm-sel wide">${["", "firefox", "chrome", "chromium", "brave", "edge", "opera", "vivaldi"].map(b => `<option value="${b}" ${s.cookiesBrowser === b ? "selected" : ""}>${b || "None"}</option>`).join("")}</select></div>
      <div class="set-hint">⚠️ A logged-in YouTube session often gets blocked (“format not available”) and is more traceable on your account — keep <b>None</b> unless you need age/member-restricted content. Failed calls retry without cookies automatically.</div>`}
      <div class="set-row"><label>Search results</label>
        <select id="setLimit" class="sel sm-sel">${[10, 20, 30, 50, 75, 100].map(n => `<option value="${n}" ${Number(s.searchLimit) === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="set-row"><label>Show videos in search</label><input type="checkbox" id="setIncVid" ${s.ytIncludeVideos !== false ? "checked" : ""}></div>
      <div class="set-row"><label>Show playlists in search</label><input type="checkbox" id="setIncPl" ${s.ytIncludePlaylists !== false ? "checked" : ""}></div>
      <div class="set-hint">The main search bar returns both. You can also toggle Videos / Playlists right on the results page.</div>
      <div class="set-row"><label>Playlist preview size <span class="set-sub">(tracks shown in the detail window · 1–200)</span></label><input type="number" id="setPlPrev" class="num-in" min="1" max="200" step="5" value="${s.playlistPreviewCount ?? 25}"></div>
      <div class="set-row"><label>Prefer local file when downloaded</label><input type="checkbox" id="setPrefLocal" ${s.preferLocal ? "checked" : ""}></div>
      <div class="set-hint">When a track has been saved locally (file named “… [id].mp3”), play the local file instead of streaming from YouTube.</div>
      <div class="set-row"><label>Unavailable tracks remembered</label><button id="setDlBlock" class="btn-line sm">Forget ${Object.keys(dlBlock).length}</button></div>
      <div class="set-hint">Premium-only / deleted / private videos are never re-attempted. “Forget” lets them be tried once again.</div>
      <div class="set-row"><label>First-run setup</label><button id="setRerun" class="btn-line sm">Run again…</button></div>
    </div>
    </section>
    <section class="set-pane" data-pane="downloads">
    <div class="set-group"><div class="set-title">Downloads</div>
      <div class="set-row"><label>Download folder</label>
        <span class="dir-pick">
          <input type="text" id="setDlDir" class="text-in" placeholder="~/Music/MusicPlayer" value="${esc(s.downloadDir)}">
          <button id="setDlPick" class="btn-line sm" title="Choose a folder (any disk)">${ic(IC.folder)}</button>
        </span></div>
      <div class="set-row"><label>Download quality</label>
        <select id="setDlQuality" class="sel sm-sel">${[["best","Best available"],["320","320 kbps"],["256","256 kbps"],["192","192 kbps"],["128","128 kbps (smallest)"]].map(([v,l]) => `<option value="${v}" ${(s.downloadQuality||"best")===v?"selected":""}>${l}</option>`).join("")}</select></div>
      <div class="set-hint">Applies to single tracks and whole-playlist downloads. Lower = smaller files. On desktop with yt-dlp it caps the mp3 bitrate; the built-in engine picks the closest audio stream.</div>
      <div class="set-row"><label>Simultaneous downloads</label>
        <select id="setDlConcurrency" class="sel sm-sel">${[1,2,3,4].map(v => `<option value="${v}" ${(Number(s.dlConcurrency) || 3) === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div class="set-hint">More parallel downloads clear a big queue faster, but raise the chance YouTube rate-limits you.</div>
      <div class="set-row"><label>Storage cap <span class="set-sub">(max MB of audio per source folder · 0 = unlimited)</span></label><input type="number" id="setStorageCap" class="num-in" min="0" max="1000000" step="500" value="${s.storageCapMb ?? 0}"></div>
      <div class="set-hint" id="setStorageUse">When the download folder reaches this size, new downloads are skipped so it never overflows.</div>
      <div class="set-row"><label>Tick “Save locally” by default when importing</label><input type="checkbox" id="setAutoSave" ${s.autoSaveImports ? "checked" : ""}></div>
      <div class="set-row"><label>Resume unfinished downloads on launch</label><input type="checkbox" id="setResumeDl" ${s.resumeDownloads ? "checked" : ""}></div>
      <div class="set-hint">Where downloads are saved. Pick any folder with the folder picker. Empty = <b>${IS_ANDROID ? "/storage/emulated/0/Music/MusicPlayer" : "~/Music/MusicPlayer"}</b>. The folder is added as a source automatically after a download.</div>
    </div>
    <div class="set-group"><div class="set-title">Blocked tracks</div>
      <div class="set-row"><label>Show blocked tracks <span class="set-sub">(greyed instead of hidden)</span></label><input type="checkbox" id="setShowBlocked" ${s.showBlocked ? "checked" : ""}></div>
      <div class="set-row"><label>Blocked</label><button id="setUnblockAll" class="btn-line sm">Unblock ${blockedKeys.size}</button></div>
      <div class="set-hint">Right-click a track → <b>Block</b> to hide it and stop it from ever playing (even if it's saved locally), until you unblock it.</div>
    </div>
    </section>
    <section class="set-pane" data-pane="integrations">
    <div class="set-group"><div class="set-title">Account &amp; cloud sync</div>
      ${s.gdriveTokens?.refresh_token
        ? `<div class="set-row"><label>Signed in</label><b>${esc(s.gdriveTokens.email || "Google account")}</b></div>
           <div class="set-row"><label>Auto-sync <span class="set-sub">(on launch + after changes)</span></label><input type="checkbox" id="setSyncAuto" ${s.syncAuto !== false ? "checked" : ""}></div>
           <div class="set-row"><label>${s.syncAt ? "Last synced " + new Date(s.syncAt).toLocaleString() : "Never synced"}</label>
             <span class="dir-pick"><button id="setSyncNow" class="btn-line sm">Sync now</button><button id="setSignOut" class="btn-line sm">Sign out</button></span></div>
           <div class="set-hint">Playlists, settings, blocked tracks and follows sync through the private app folder of your Google Drive — same account on any device stays in sync, anywhere. Your audio files are not uploaded (use “Share over WiFi” for those).</div>`
        : `<div class="set-hint">Sign in with Google to sync your playlists / settings / blocked / follows across your devices through your own Google Drive (nothing goes to us). Audio files aren't uploaded.<br><br><b>One-time setup:</b> create a free OAuth client at <b>console.cloud.google.com</b> → APIs &amp; Services → Credentials → <i>Create OAuth client ID</i> → application type <b>Desktop app</b>, enable the <b>Google Drive API</b>, then paste the Client ID (and secret) below.</div>
           <div class="set-row"><label>Google OAuth Client ID</label><input type="text" id="setGdId" class="text-in" placeholder="…apps.googleusercontent.com" value="${esc(s.gdriveClientId)}"></div>
           <div class="set-row"><label>Client secret <span class="set-sub">(Desktop app)</span></label><input type="text" id="setGdSecret" class="text-in" placeholder="GOCSPX-…" value="${esc(s.gdriveClientSecret)}"></div>
           <button id="setSignIn" class="btn">Sign in with Google</button>`}
    </div>
    <div class="set-group"><div class="set-title">Notifications</div>
      <div class="set-row"><label>Desktop notification on track change</label><input type="checkbox" id="setNotify" ${s.notifyOnChange ? "checked" : ""}></div>
      <div class="set-hint">Tip: your desktop's media widget already shows the track (MPRIS) — turn this off if you see two popups.</div>
    </div>
    <div class="set-group"><div class="set-title">Discord Rich Presence</div>
      <div class="set-row"><label>Show what I'm listening to</label><input type="checkbox" id="setRpc" ${s.rpcEnabled ? "checked" : ""}></div>
      <div class="set-row"><label>Discord Application ID</label><input type="text" id="setRpcId" class="text-in" placeholder="Discord app client id" value="${esc(s.rpcClientId)}"></div>
      <div class="set-hint">Create an app at <b>discord.com/developers</b> → copy its <b>Application ID</b>. Requires the Discord desktop app running.</div>
      <div class="set-row"><label>Show delay on a new track <span class="set-sub">(seconds)</span></label><input type="number" id="setRpcDelay" class="num-in" min="0" max="60" step="1" value="${s.rpcDelay ?? 0}"></div>
      <div class="set-hint">Wait this long before updating Discord — skipping quickly through tracks then won't spam it (only what you settle on shows).</div>
      <div class="set-row"><label>Remove when paused after <span class="set-sub">(seconds · 0 = at once)</span></label><input type="number" id="setRpcPause" class="num-in" min="0" max="3600" step="5" value="${s.rpcPauseClear ?? 0}"></div>
      <div class="set-hint">When you pause, how long before the presence disappears from Discord. It comes back instantly on resume.</div>
    </div>
    </section>
    <section class="set-pane" data-pane="library">
    <div class="set-group"><div class="set-title">Followed playlists</div>
      <div class="set-row"><label>Check for new tracks</label>
        <select id="setFollowIv" class="sel sm-sel wide">
          <option value="launch" ${s.followInterval === "launch" ? "selected" : ""}>On launch only</option>
          <option value="1h" ${s.followInterval === "1h" ? "selected" : ""}>Every hour</option>
          <option value="6h" ${s.followInterval === "6h" ? "selected" : ""}>Every 6 hours</option>
          <option value="24h" ${s.followInterval === "24h" ? "selected" : ""}>Every day</option>
        </select></div>
      <div id="setFollowList"></div>
      <div class="set-row"><label></label><button id="setFollowCheck" class="btn-line sm">${ic(IC.repeat)}Check all now</button></div>
      <div class="set-hint">Follow a playlist from <b>Import from URL…</b> (tick “Follow”). New upstream tracks land in the linked playlist; with the download option they are also downloaded to the library. Checks also run on launch.</div>
    </div>
    </section>
    <section class="set-pane" data-pane="system">
    ${IS_ANDROID ? "" : `<div class="set-group"><div class="set-title">Startup</div>
      <div class="set-row"><label>Launch at login</label><input type="checkbox" id="setBoot" ${s.startOnBoot ? "checked" : ""} ${IS_NATIVE ? "" : "disabled"}></div>
      <div class="set-hint">Start Music Player automatically when you sign in. On Linux this adds a desktop entry to your autostart folder; on Windows/macOS it registers a login item.${IS_NATIVE ? "" : " <b>Needs the native app.</b>"}</div>
    </div>`}
    <div class="set-group"><div class="set-title">Updates</div>
      <div class="set-row"><label>When a new version is available</label>
        <select id="setUpdMode" class="sel sm-sel wide">
          <option value="auto" ${s.updateMode === "auto" ? "selected" : ""}>Automatic</option>
          <option value="ask" ${s.updateMode === "ask" ? "selected" : ""}>Notify me</option>
          <option value="off" ${s.updateMode === "off" ? "selected" : ""}>Don't check</option>
        </select></div>
      <div class="set-row"><label>Version <b id="setCurVer">…</b></label>
        <span class="dir-pick">
          <button id="setUpdCheck" class="btn-line sm">Check now</button>
          <button id="updateBtn" class="btn-line sm" hidden>Update</button>
        </span></div>
      <div class="set-hint" id="setAudioInfo">Audio output: checking…</div>
      <div class="set-hint" id="setEngineInfo"></div>
      <div class="set-hint" id="setUpdHint">${IS_ANDROID
        ? "Automatic: instant updates apply on launch, and new APKs download themselves — Android only asks you to tap Install (that prompt can't be skipped). Notify me: shows an Update button instead. Android and desktop versions update independently."
        : "Automatic: instant updates apply on launch, and new installers download and run themselves. Notify me: shows an Update button instead."}</div>
      <div class="set-row" id="setVerRow" hidden><label>Switch / downgrade version</label>
        <span class="dir-pick">
          <select id="setVerSel" class="sel sm-sel wide"><option value="">Loading versions…</option></select>
          <button id="setVerGo" class="btn-line sm" disabled>Build</button>
        </span></div>
      <div class="set-hint" id="setVerHint" hidden>Rebuilds a chosen version from the local source tree before restarting (desktop dev only).</div>
    </div>
    <div class="set-actions"><button id="setReset" class="btn-line">↺ Reset to defaults</button></div>
    </section>
    </div>`;
  const body = $("#settingsBody");
  // Tab navigation: show one category pane at a time (all IDs stay in the DOM so
  // every field handler below still binds regardless of the active tab).
  body.querySelectorAll(".set-tab").forEach(tab => tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    body.querySelectorAll(".set-tab").forEach(x => x.classList.toggle("on", x === tab));
    body.querySelectorAll(".set-pane").forEach(p => p.classList.toggle("on", p.dataset.pane === name));
    body.querySelector(".set-panes").scrollTop = 0;
  }));
  // "Launch at login": the autostart plugin owns the real OS state — reflect it
  // on open, and flip it (with rollback on failure) when the box is toggled.
  // Desktop only — the plugin isn't compiled on Android (no #setBoot there).
  if (IS_NATIVE && $("#setBoot")) {
    T.core.invoke("plugin:autostart|is_enabled").then(on => {
      const el = $("#setBoot"); if (el) el.checked = !!on;
      if (!!on !== S().startOnBoot) SETTINGS.setSetting("startOnBoot", !!on);
    }).catch(e => console.error("[autostart] is_enabled", e));
    $("#setBoot").addEventListener("change", async e => {
      const on = e.target.checked;
      try {
        await T.core.invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
        SETTINGS.setSetting("startOnBoot", on);
        flash(on ? "Music Player will launch at login" : "Launch at login disabled");
      } catch (err) {
        console.error("[autostart]", err);
        e.target.checked = !on;
        flash("Couldn't change the startup setting");
      }
    });
  }
  body.querySelectorAll("[data-accent]").forEach(b => b.addEventListener("click", () => { SETTINGS.setSetting("accent", b.dataset.accent); applyAccent(); body.querySelectorAll(".swatch").forEach(x => x.classList.toggle("on", x === b)); }));
  $("#setTheme").addEventListener("change", e => { SETTINGS.setSetting("theme", e.target.value); applyTheme(); });
  for (const [id, key] of [["setCustBg", "customBg"], ["setCustPanel", "customPanel"], ["setCustText", "customText"]]) {
    $("#" + id).addEventListener("input", e => {
      SETTINGS.setSetting(key, e.target.value);
      if (S().theme !== "custom") { SETTINGS.setSetting("theme", "custom"); $("#setTheme").value = "custom"; }
      applyTheme();
    });
  }
  $("#setRadius").addEventListener("input", e => { SETTINGS.setSetting("radius", Number(e.target.value)); applyTheme(); });
  $("#setScale").addEventListener("input", e => { SETTINGS.setSetting("uiScale", Number(e.target.value)); applyTheme(); });
  $("#setBgImg").addEventListener("change", e => { SETTINGS.setSetting("bgImage", e.target.value.trim()); applyTheme(); });
  $("#setBgPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Choose a background image", filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] }] } });
      if (p) { SETTINGS.setSetting("bgImage", p); $("#setBgImg").value = p; applyTheme(); }
    } catch (e) { console.error("[bg pick]", e); }
  });
  $("#setBgClear").addEventListener("click", () => { SETTINGS.setSetting("bgImage", ""); $("#setBgImg").value = ""; applyTheme(); });
  $("#setBgBlur").addEventListener("input", e => { SETTINGS.setSetting("bgBlur", Number(e.target.value)); applyTheme(); });
  $("#setBgDim").addEventListener("input", e => { SETTINGS.setSetting("bgDim", Number(e.target.value)); applyTheme(); });
  $("#setPanelA").addEventListener("input", e => { SETTINGS.setSetting("panelAlpha", Number(e.target.value)); applyTheme(); });
  $("#setBgText").addEventListener("change", e => { SETTINGS.setSetting("bgTextMode", e.target.value); applyTheme(); });
  for (const [id, key] of [["setUiSources", "uiSources"], ["setUiSrcBtns", "uiSrcButtons"], ["setUiPlaylists", "uiPlaylists"], ["setUiImport", "uiImportBtn"], ["setUiSort", "uiSortSel"], ["setUiDock", "npDocked"]]) {
    $("#" + id).addEventListener("change", e => { SETTINGS.setSetting(key, e.target.checked); applyUiPrefs(); });
  }
  $("#setArt").addEventListener("change", e => { SETTINGS.setSetting("showArt", e.target.checked); refreshView(); });
  $("#setCompact").addEventListener("change", e => { SETTINGS.setSetting("compactRows", e.target.checked); document.body.classList.toggle("compact", e.target.checked); });
  $("#setAnim").addEventListener("change", e => { SETTINGS.setSetting("animations", e.target.checked); document.body.classList.toggle("no-anim", !e.target.checked); });
  $("#setSmooth").addEventListener("change", e => { SETTINGS.setSetting("smoothScroll", e.target.checked); document.body.classList.toggle("smooth", e.target.checked); });
  $("#setSmoothAmt").addEventListener("input", e => SETTINGS.setSetting("smoothStrength", Number(e.target.value)));
  $("#setVol").addEventListener("change", e => { SETTINGS.setSetting("defaultVolume", Number(e.target.value)); $("#volume").value = e.target.value; invoke("set_volume", { level: Number(e.target.value) / 100 }); });
  $("#setNorm").addEventListener("change", e => { SETTINGS.setSetting("normalizeDefault", e.target.checked); normalize = e.target.checked; invoke("set_agc", { on: normalize }).catch(() => {}); });
  $("#setShuf").addEventListener("change", e => { SETTINGS.setSetting("shuffleDefault", e.target.checked); shuffle = e.target.checked; $("#shuffleBtn").classList.toggle("active", shuffle); if (curIndex >= 0) schedulePreload(); });
  $("#setNotify").addEventListener("change", e => SETTINGS.setSetting("notifyOnChange", e.target.checked));
  $("#setPreload").addEventListener("change", e => { SETTINGS.setSetting("preloadNext", e.target.checked); if (curIndex >= 0) schedulePreload(); });
  const ytStatus = (msg, ok) => { const el = $("#setYtStatus"); if (!el) return; el.textContent = msg; el.style.color = ok ? "#34d399" : (ok === false ? "#f59e0b" : ""); };
  const ytTest = async () => {
    ytStatus("Testing…");
    try { ytStatus(`${await ytConfigPush()}`, true); }
    catch (e) { ytStatus(`${e}`, false); }
  };
  // yt-dlp controls only exist on desktop (hidden on Android) — guard every one.
  $("#setYtPath")?.addEventListener("change", e => { SETTINGS.setSetting("ytdlpPath", e.target.value.trim()); ytTest(); });
  $("#setYtTest")?.addEventListener("click", ytTest);
  $("#setYtInstall")?.addEventListener("click", async () => {
    const btn = $("#setYtInstall"); btn.disabled = true;
    ytStatus("Downloading yt-dlp… (this can take a moment)");
    try { const r = await ytInstall(); $("#setYtPath").value = ""; ytStatus(`Installed: ${r}`, true); flash("yt-dlp installed"); }
    catch (e) { ytStatus(`${e}`, false); }
    finally { btn.disabled = false; }
  });
  $("#setYtPick")?.addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Pick the yt-dlp binary" } });
      if (p) { SETTINGS.setSetting("ytdlpPath", p); $("#setYtPath").value = p; ytTest(); }
    } catch (e) { console.error("[yt pick]", e); }
  });
  $("#setCookies")?.addEventListener("change", async e => {
    const prev = S().cookiesBrowser;
    const v = e.target.value;
    if (!v) { SETTINGS.setSetting("cookiesBrowser", ""); ytConfigPush().catch(() => {}); return; }
    const chosen = await askCookieConsent(v);
    if (chosen) { SETTINGS.setSetting("cookiesBrowser", chosen); ytConfigPush().catch(() => {}); flash(`Cookies: ${chosen}`); }
    else { e.target.value = prev.split(":")[0] || ""; }
  });
  $("#setIncVid")?.addEventListener("change", e => SETTINGS.setSetting("ytIncludeVideos", e.target.checked));
  $("#setIncPl")?.addEventListener("change", e => SETTINGS.setSetting("ytIncludePlaylists", e.target.checked));
  $("#setPlPrev")?.addEventListener("change", e => SETTINGS.setSetting("playlistPreviewCount", Math.max(1, Math.min(200, Number(e.target.value) || 25))));
  $("#setDlQuality")?.addEventListener("change", e => SETTINGS.setSetting("downloadQuality", e.target.value));
  $("#setDlConcurrency")?.addEventListener("change", e => SETTINGS.setSetting("dlConcurrency", Math.max(1, Math.min(4, Number(e.target.value) || 3))));
  $("#setStorageCap")?.addEventListener("change", e => SETTINGS.setSetting("storageCapMb", Math.max(0, Number(e.target.value) || 0)));
  $("#setShowBlocked")?.addEventListener("change", e => { SETTINGS.setSetting("showBlocked", e.target.checked); refreshView(); });
  // Account & cloud sync
  $("#setGdId")?.addEventListener("change", e => SETTINGS.setSetting("gdriveClientId", e.target.value.trim()));
  $("#setGdSecret")?.addEventListener("change", e => SETTINGS.setSetting("gdriveClientSecret", e.target.value.trim()));
  $("#setSignIn")?.addEventListener("click", accountSignIn);
  $("#setSignOut")?.addEventListener("click", accountSignOut);
  $("#setSyncNow")?.addEventListener("click", syncNow);
  $("#setSyncAuto")?.addEventListener("change", e => SETTINGS.setSetting("syncAuto", e.target.checked));
  $("#setUnblockAll")?.addEventListener("click", () => { blockedKeys.clear(); saveBlocked(); $("#setUnblockAll").textContent = "Unblock 0"; refreshView(); flash("All tracks unblocked"); });
  $("#setDlBlock").addEventListener("click", () => { dlBlock = {}; saveDlBlock(); $("#setDlBlock").textContent = "Forget 0"; flash("Unavailable-track list cleared"); });
  $("#setRerun").addEventListener("click", () => { $("#settingsModal").hidden = true; openSetup(); });
  $("#setLimit").addEventListener("change", e => SETTINGS.setSetting("searchLimit", Number(e.target.value)));
  $("#setPrefLocal").addEventListener("change", e => SETTINGS.setSetting("preferLocal", e.target.checked));
  $("#setAutoSave").addEventListener("change", e => SETTINGS.setSetting("autoSaveImports", e.target.checked));
  $("#setResume").addEventListener("change", e => { SETTINGS.setSetting("resumePlayback", e.target.checked); if (e.target.checked) savePlayback(); else storeSave("playback", ""); });
  $("#setResumeDl").addEventListener("change", e => { SETTINGS.setSetting("resumeDownloads", e.target.checked); if (e.target.checked) saveDlQueue(); else storeSave("dlqueue", ""); });
  $("#setHist").addEventListener("change", e => {
    const v = Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0)));
    e.target.value = v; SETTINGS.setSetting("historyLimit", v);
    if (!v) { history2 = []; saveHistory(); } else if (history2.length > v) { history2.length = v; saveHistory(); }
    applyUiPrefs();
  });
  $("#setRpcDelay").addEventListener("change", e => SETTINGS.setSetting("rpcDelay", Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0)))));
  $("#setRpcPause").addEventListener("change", e => SETTINGS.setSetting("rpcPauseClear", Math.max(0, Math.min(3600, Math.round(Number(e.target.value) || 0)))));
  $("#setCompactTop").addEventListener("change", e => { SETTINGS.setSetting("compactTopbar", e.target.checked); document.body.classList.toggle("compact-top", e.target.checked); });
  $("#setTopPad").addEventListener("input", e => { SETTINGS.setSetting("topbarPad", Number(e.target.value)); document.documentElement.style.setProperty("--topbar-pad", `${e.target.value}px`); });
  $("#setThumbSize").addEventListener("input", e => { SETTINGS.setSetting("thumbSize", Number(e.target.value)); document.documentElement.style.setProperty("--thumb-size", `${e.target.value}px`); });
  $("#setThumbImg").addEventListener("change", e => { SETTINGS.setSetting("sliderImage", e.target.value.trim()); applyThumbImage(S()); });
  $("#setThumbPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Choose a slider image", filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] }] } });
      if (p) { SETTINGS.setSetting("sliderImage", p); $("#setThumbImg").value = p; applyThumbImage(S()); }
    } catch (e) { console.error("[thumb pick]", e); }
  });
  $("#setThumbClear").addEventListener("click", () => { SETTINGS.setSetting("sliderImage", ""); $("#setThumbImg").value = ""; applyThumbImage(S()); });
  initVersionSwitcher();
  $("#setDlDir").addEventListener("change", e => SETTINGS.setSetting("downloadDir", e.target.value.trim()));
  $("#setDlPick").addEventListener("click", async () => {
    if (!IS_NATIVE) { flash("Folder picker needs the native app"); return; }
    try {
      const path = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose the download folder" } });
      if (path) { SETTINGS.setSetting("downloadDir", path); $("#setDlDir").value = path; }
    } catch (e) { console.error("[dl dir]", e); }
  });
  $("#setRpc").addEventListener("change", e => { SETTINGS.setSetting("rpcEnabled", e.target.checked); if (e.target.checked) updateRPC(trackByPath(queue[curIndex]), playing); else clearRPC(); });
  $("#setRpcId").addEventListener("change", e => { SETTINGS.setSetting("rpcClientId", e.target.value.trim()); if (S().rpcEnabled) updateRPC(trackByPath(queue[curIndex]), playing); });
  $("#setFollowIv").addEventListener("change", e => SETTINGS.setSetting("followInterval", e.target.value));
  $("#setFollowCheck").addEventListener("click", () => checkFollows(true));
  renderFollowList();
  $("#setUpdMode").addEventListener("change", e => SETTINGS.setSetting("updateMode", e.target.value));
  $("#setUpdCheck").addEventListener("click", () => checkUpdate(true));
  $("#updateBtn").addEventListener("click", () => {
    if (updateReady) { invoke("restart_app").catch(e => { console.error("[restart]", e); flash("Restart failed — relaunch manually"); }); return; }
    if (!updateBusy && availableVersion) runUpdate();
  });
  renderUpdateBtn();  // reflect state already known from the startup check
  checkUpdate();      // refresh in the background while the panel is open
  currentVersion().then(v => { const el = $("#setCurVer"); if (!el) return; const ota = window.__MP_OTA__; el.textContent = (ota ? `v${ota} (OTA)` : (v ? `v${v}` : "?")) + ` · ${platformName()}`; });
  if (IS_NATIVE) invoke("audio_info").then(cfg => { const el = $("#setAudioInfo"); if (el) el.textContent = cfg ? `Audio output: ${cfg}` : "Audio output: NO DEVICE OPENED — that's why there's no sound"; }).catch(() => {});
  // WebView engine version — pinpoints which CSS/JS features the device lacks.
  { const el = $("#setEngineInfo"); if (el) el.textContent = `Engine: ${navigator.userAgent}` + (window.__MP_OTA__ ? ` · OTA v${window.__MP_OTA__}` : ""); }
  $("#setReset").addEventListener("click", () => { SETTINGS.resetSettings(); applySettings(); refreshView(); openSettings(); flash("Settings reset to defaults"); });
  // Live storage usage of the download folder (best-effort, async).
  if (IS_NATIVE) {
    const dlDir = S().downloadDir || (IS_ANDROID ? ANDROID_MUSIC_DIR + "/MusicPlayer" : "");
    if (dlDir) invoke("folder_size", { path: dlDir }).then(bytes => {
      const el = $("#setStorageUse"); if (!el) return;
      const mb = bytes / (1024 * 1024);
      const cap = Number(S().storageCapMb) || 0;
      el.innerHTML = `Currently <b>${mb < 1024 ? mb.toFixed(0) + " MB" : (mb / 1024).toFixed(2) + " GB"}</b> used${cap ? ` of ${cap} MB` : ""}. When the folder reaches the cap, new downloads are skipped.`;
    }).catch(() => {});
  }
  $("#settingsModal").hidden = false;
}

// ─── Followed playlists: periodically re-fetch an external playlist and
// auto-add its NEW tracks to a local playlist (and optionally auto-download
// them to the library). Persisted in store "follows". ───
let follows = []; // {id, url, title, playlistId, autoDownload, enabled, knownIds[], lastChecked}
let _followsBusy = false;
const FOLLOW_IVALS = { launch: 0, "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3 };

async function loadFollows() {
  const raw = await storeLoad("follows");
  if (raw) { try { follows = JSON.parse(raw); } catch {} }
  if (!Array.isArray(follows)) follows = [];
}
function saveFollows() { storeSave("follows", JSON.stringify(follows)); }
function followFor(playlistId) { return follows.find(f => f.playlistId === playlistId && f.enabled !== false); }
function addFollow({ url, title, playlistId, autoDownload, knownIds }) {
  const dup = follows.find(f => f.url === url);
  if (dup) { // re-following the same URL updates the existing follow
    Object.assign(dup, { title: title || dup.title, playlistId, autoDownload, enabled: true });
    dup.knownIds = [...new Set([...(dup.knownIds || []), ...knownIds])];
  } else {
    follows.push({ id: crypto.randomUUID(), url, title: title || "Playlist", playlistId, autoDownload: !!autoDownload, enabled: true, knownIds, lastChecked: Date.now() });
  }
  saveFollows();
}

async function checkFollow(f, manual = false) {
  let res;
  try { res = await invoke("yt_playlist", { url: f.url }); }
  catch (e) { console.warn("[follow]", f.title, e); if (manual) flash(`“${f.title}”: check failed — ${e}`); return 0; }
  f.lastChecked = Date.now();
  if (res.title) f.title = res.title;
  const tracks = (res.tracks || []).map(onlineFromResult);
  const known = new Set(f.knownIds || []);
  const fresh = tracks.filter(t => !known.has(ytId(t.path)));
  // Union: a track removed upstream then re-added must not come back as "new".
  f.knownIds = [...new Set([...(f.knownIds || []), ...tracks.map(t => ytId(t.path))])];
  if (!fresh.length) { if (manual) flash(`“${f.title}” — no new tracks`); return 0; }
  fresh.forEach(t => onlineIndex.set(t.path, t));
  const pl = PL.getPlaylists().find(p => p.id === f.playlistId);
  if (pl) fresh.forEach(t => PL.addToPlaylist(f.playlistId, t.path));
  await saveOnline();
  renderPlaylists(); refreshView();
  if (f.autoDownload) downloadTracks(fresh.map(t => t.path));
  flash(`${fresh.length} new track${fresh.length === 1 ? "" : "s"} from “${f.title}”${pl ? ` → “${pl.name}”` : ""}${f.autoDownload ? " · downloading" : ""}`);
  return fresh.length;
}

async function checkFollows(manual = false, respectDue = false) {
  if (!IS_NATIVE || _followsBusy) return;
  _followsBusy = true;
  try {
    const ivMs = FOLLOW_IVALS[S().followInterval] ?? FOLLOW_IVALS["6h"];
    let total = 0, ran = 0;
    for (const f of [...follows]) {
      if (f.enabled === false) continue;
      if (respectDue && (ivMs === 0 || Date.now() - (f.lastChecked || 0) < ivMs)) continue;
      total += await checkFollow(f, manual);
      ran++;
      await sleep(1500); // pacing between yt-dlp calls
    }
    saveFollows();
    if (manual) flash(!ran ? "No followed playlists to check" : total ? `${total} new track${total === 1 ? "" : "s"} added` : "Follows are up to date");
  } finally { _followsBusy = false; }
}

// ─── Self-update (binary vs. source-tree version; repo mirrored on GitHub) ───
let updateBusy = false, updateReady = false, availableVersion = "";
async function currentVersion() {
  try { return await T.app.getVersion(); } catch { return ""; }
}
// The Update button lives in Settings → Updates, so it only exists in the DOM
// while the panel is open. Reflect the current state onto it when present.
function renderUpdateBtn() {
  const btn = $("#updateBtn");
  if (!btn) return;
  btn.disabled = updateBusy;
  const isDownload = _releaseInfo && (_releaseInfo.asset_url || _releaseInfo.page_url);
  if (updateBusy) { btn.hidden = false; btn.textContent = _otaMode ? "Updating…" : "Building update…"; }
  else if (updateReady) { btn.hidden = false; btn.textContent = `v${availableVersion} ready — restart`; }
  else if (availableVersion) { btn.hidden = false; btn.textContent = _otaMode ? `Update to v${availableVersion} (instant)` : (isDownload ? `Download v${availableVersion}` : `Update to v${availableVersion}`); }
  else { btn.hidden = true; }
}
// cmp semver-ish "a.b.c" → -1 / 0 / 1
function verCmp(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
let _releaseInfo = null; // { version, asset_url, page_url, platform }
let _otaMode = false;    // an instant (no-reinstall) frontend update is available
let _updChecked = false; // first check of the session = the boot check
async function checkUpdate(manual = false) {
  if (!IS_NATIVE) return;
  if (!manual && S().updateMode === "off") return;
  // Auto mode applies the OTA only on the BOOT check — it reloads the app, so
  // a later background check must not yank a playing session; those show the
  // Update button instead. Release installs (below) are safe to auto-run any
  // time: the download runs in the background and Android's install prompt /
  // the desktop installer only appears once it's ready.
  const atBoot = !_updChecked; _updChecked = true;
  const autoMode = S().updateMode === "auto" && !manual;
  // Prefer an over-the-air frontend update: it applies instantly, no reinstall,
  // on every platform. Only fall back to the APK/installer path (native code
  // changes) when no OTA is offered.
  try {
    const ota = await invoke("ota_check");
    if (ota && ota.available) {
      _otaMode = true; availableVersion = ota.version; _releaseInfo = null;
      renderUpdateBtn();
      if (autoMode && atBoot) { runUpdate(); return; }
      if (manual) flash(`Instant update available: v${ota.current} → v${ota.version}`);
      return;
    }
    _otaMode = false;
  } catch (e) { _otaMode = false; }
  const cur = await currentVersion();
  // Desktop with a source tree keeps the in-app rebuild flow; everyone else
  // (installers, Android) checks GitHub for the newest release that ships an
  // asset for THIS platform — versions are independent per platform.
  const src = await invoke("source_version").catch(() => "");
  const hasSourceTree = !!src;
  if (hasSourceTree) {
    if (src && cur && src !== cur) {
      availableVersion = src; _releaseInfo = null;
      if (autoMode) { runUpdate(); return; }
      if (manual) flash(`Update available: v${cur} → v${src}`);
    } else {
      availableVersion = ""; if (manual) flash(`Up to date (v${cur})`);
    }
  } else {
    try {
      const rel = await invoke("latest_release");
      _releaseInfo = rel;
      if (rel.version && cur && verCmp(rel.version, cur) > 0) {
        availableVersion = rel.version;
        // Auto mode: Android downloads the APK and pops the system installer,
        // desktop installer builds download and launch the setup — same
        // hands-off behavior the source-tree path has always had.
        if (autoMode) { renderUpdateBtn(); runUpdate(); return; }
        if (manual) flash(`Update available for ${rel.platform}: v${cur} → v${rel.version}`);
      } else {
        availableVersion = ""; if (manual) flash(`Up to date (v${cur})`);
      }
    } catch (e) {
      availableVersion = ""; if (manual) flash(`Could not check updates: ${e}`);
    }
  }
  renderUpdateBtn();
}
async function runUpdate() {
  if (updateBusy || !IS_NATIVE) return;
  // Instant OTA path: download the new frontend and reload into it — no
  // reinstall, works everywhere. The index.html bootstrap picks it up on reload.
  if (_otaMode) {
    updateBusy = true; renderUpdateBtn();
    try {
      const v = await invoke("ota_apply");
      flash(`Updated to v${v} — reloading…`);
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      updateBusy = false; renderUpdateBtn();
      flash(`Update failed: ${e}`);
    }
    return;
  }
  // Android / installer builds have no source tree to rebuild — always go
  // through the GitHub release download. Fetch the release info on the fly if
  // the earlier check didn't populate it (e.g. it errored the first time).
  const noSourceTree = IS_ANDROID || !(await invoke("source_version").catch(() => ""));
  if (noSourceTree) {
    if (!_releaseInfo) { try { _releaseInfo = await invoke("latest_release"); } catch (e) { flash(`Could not find a release: ${e}`); return; } }
    const url = _releaseInfo && (_releaseInfo.asset_url || _releaseInfo.page_url);
    if (!url) { flash("No downloadable release found for this platform"); return; }
    // Android: download the APK in-app (with progress in the Activity center),
    // then hand it straight to the system installer — no browser, no GitHub,
    // just "Install". Falls back to opening the download if anything fails.
    if (IS_ANDROID && _releaseInfo.asset_url) {
      updateBusy = true; renderUpdateBtn();
      const tid = taskStart(`Update v${availableVersion}`, { detail: "downloading APK… 0%" });
      _apkTask = tid;
      try {
        const path = await invoke("download_apk", { url: _releaseInfo.asset_url });
        taskEnd(tid, { detail: "downloaded — installer opened", ttl: 8000 });
        await invoke("install_apk", { path });
        flash("Tap Install in the Android prompt — your settings are kept");
      } catch (e) {
        taskEnd(tid, { status: "error", detail: String(e) });
        try { await invoke("open_url", { url }); flash("Opening the APK download instead…"); } catch {}
      }
      _apkTask = null; updateBusy = false; renderUpdateBtn();
      return;
    }
    // Desktop installer builds (Windows/macOS/AppImage): download the setup
    // in-app — progress in the Activity center — then hand it to the OS.
    // GitHub only opens as the last-resort fallback (e.g. an old binary that
    // doesn't know the download_installer command yet).
    if (!IS_ANDROID && _releaseInfo?.asset_url) {
      updateBusy = true; renderUpdateBtn();
      const tid = taskStart(`Update v${availableVersion}`, { detail: "downloading installer… 0%" });
      _apkTask = tid;
      try {
        const path = await invoke("download_installer", { url: _releaseInfo.asset_url });
        taskEnd(tid, { detail: "downloaded — installer starting", ttl: 8000 });
        await invoke("run_installer", { path });
        flash("Installer launched — the app restarts updated. Your settings are kept.");
      } catch (e) {
        taskEnd(tid, { status: "error", detail: String(e) });
        try { await invoke("open_url", { url }); flash("Opening the download instead…"); } catch {}
      }
      _apkTask = null; updateBusy = false; renderUpdateBtn();
      return;
    }
    try {
      await invoke("open_url", { url });
      flash(IS_ANDROID ? "Opening the APK download — open the file to install" : "Opening the download page…");
    } catch (e) { flash(`Could not open the download: ${e}`); }
    return;
  }
  // Desktop dev with a source tree: rebuild in place.
  updateBusy = true; renderUpdateBtn();
  try {
    await invoke("self_update");
    updateReady = true; updateBusy = false; renderUpdateBtn();
    flash(`Update v${availableVersion} built — click the button to restart`);
    notifyTrack({ title: "Music Player update ready", artist: `Click the update button in Settings to restart into v${availableVersion}`, album: "" });
  } catch (e) {
    updateBusy = false;
    const btn = $("#updateBtn"); if (btn) { btn.disabled = false; btn.textContent = "Update failed — retry"; }
    console.error("[update]", e);
    flash("Update failed — see console/log");
  }
}

// ─── Cookies consent: explicit accept with a countdown + detected accounts ───
let _ckResolve = null, _ckTimer = null;
function closeCookieConsent(val) {
  clearInterval(_ckTimer); _ckTimer = null;
  $("#cookieModal").hidden = true;
  const r = _ckResolve; _ckResolve = null;
  r?.(val);
}
// Returns the chosen "browser" / "browser:Profile" or null if declined.
async function askCookieConsent(browser) {
  const host = $("#ckList");
  host.innerHTML = `<div class="nx-note">Looking for installed browsers…</div>`;
  $("#cookieModal").hidden = false;
  const ok = $("#ckOk");
  ok.disabled = true;
  let left = 5;
  ok.textContent = `Accept (${left})`;
  clearInterval(_ckTimer);
  _ckTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(_ckTimer); ok.disabled = false; ok.textContent = "Accept"; }
    else ok.textContent = `Accept (${left})`;
  }, 1000);
  let infos = [];
  try { infos = await invoke("detect_browsers") || []; } catch {}
  const options = [];
  for (const b of infos) {
    if (browser && b.browser !== browser) continue;
    for (const prof of b.profiles) {
      options.push({ value: b.profiles.length > 1 || prof !== "Default" ? `${b.browser}:${prof}` : b.browser, label: `${b.browser} — ${prof} (${b.source})` });
    }
  }
  if (!options.length) options.push({ value: browser || "firefox", label: `${browser || "firefox"} — no profile found on disk (may fail)` });
  host.innerHTML = `<div class="ck-title">Detected accounts/profiles — pick which one yt-dlp will use:</div>` +
    options.map((o, i) => `<label class="ck-opt"><input type="radio" name="ckopt" value="${esc(o.value)}" ${i === 0 ? "checked" : ""}> ${esc(o.label)}</label>`).join("");
  return new Promise(res => { _ckResolve = res; });
}
function wireCookieConsent() {
  $("#ckOk").addEventListener("click", () => closeCookieConsent(document.querySelector("input[name=ckopt]:checked")?.value || null));
  $("#ckCancel").addEventListener("click", () => closeCookieConsent(null));
  $("#cookieModal").addEventListener("click", e => { if (e.target.id === "cookieModal") closeCookieConsent(null); });
}

// ─── yt-dlp configuration + first-run setup wizard ───
// Pushes the saved yt-dlp path + cookies browser to the backend; empty path =
// auto-detect (PATH, ~/Desktop/*/bin, removable drives, linuxbrew).
async function ytConfigPush() {
  if (!IS_NATIVE) return "";
  try { return await invoke("yt_config", { path: S().ytdlpPath || "", cookies: S().cookiesBrowser || "" }); }
  catch (e) { console.warn("[yt config]", e); throw e; }
}
// Download the standalone yt-dlp (self-contained) into ~/.local/bin. Clears any
// stale explicit path so auto-detect picks up the fresh copy afterwards.
async function ytInstall() {
  if (!IS_NATIVE) throw new Error("native app only");
  const r = await invoke("yt_install");
  SETTINGS.setSetting("ytdlpPath", "");
  return r;
}
function setupStep(n) {
  document.querySelectorAll("#setupModal .setup-step").forEach(el => el.hidden = el.dataset.step !== String(n));
  $("#setupTitle").textContent = n === 0 ? "Welcome" : "Setup";
}
async function setupDetect() {
  const st = $("#suYtStatus");
  if (IS_ANDROID) { st.className = "setup-status ok"; st.textContent = "Built-in YouTube engine — nothing to set up on Android."; return; }
  // yt_config auto-downloads a standalone copy when nothing is found, so this
  // may take a few seconds on first run.
  st.className = "setup-status"; st.textContent = "Setting up yt-dlp (downloading if needed)…";
  try {
    const r = await ytConfigPush();
    st.classList.add("ok"); st.textContent = `Ready: ${r}`;
  } catch (e) {
    st.classList.add("bad"); st.textContent = `${e}`;
  }
}
function finishSetup() {
  SETTINGS.setSetting("setupDone", true);
  $("#setupModal").hidden = true;
  flash("Setup saved — enjoy!");
}
function openSetup() {
  $("#suCookies").value = S().cookiesBrowser || "";
  $("#suDlDir").value = S().downloadDir || "";
  $("#suPrefLocal").checked = S().preferLocal;
  $("#suAutoSave").checked = S().autoSaveImports;
  $("#suNotify").checked = S().notifyOnChange;
  setupStep(0);
  $("#setupModal").hidden = false;
}
function wireSetup() {
  $("#suDefaults").addEventListener("click", () => { finishSetup(); ytConfigPush().catch(() => {}); });
  $("#suConfigure").addEventListener("click", () => { setupStep(1); setupDetect(); });
  $("#suYtRetry").addEventListener("click", () => { SETTINGS.setSetting("ytdlpPath", ""); setupDetect(); });
  $("#suYtPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Pick the yt-dlp binary" } });
      if (p) { SETTINGS.setSetting("ytdlpPath", p); setupDetect(); }
    } catch (e) { console.error("[setup pick]", e); }
  });
  document.querySelectorAll("#setupModal .su-next").forEach(b => b.addEventListener("click", async () => {
    const cur = Number(b.closest(".setup-step").dataset.step);
    if (cur === 2) {
      const v = $("#suCookies").value;
      if (v) {
        const chosen = await askCookieConsent(v);
        if (!chosen) { $("#suCookies").value = ""; SETTINGS.setSetting("cookiesBrowser", ""); setupStep(cur + 1); return; }
        SETTINGS.setSetting("cookiesBrowser", chosen);
      } else SETTINGS.setSetting("cookiesBrowser", "");
    }
    setupStep(cur + 1);
  }));
  $("#suDlPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose the download folder" } });
      if (p) $("#suDlDir").value = p;
    } catch (e) { console.error("[setup dir]", e); }
  });
  $("#suFinish").addEventListener("click", () => {
    SETTINGS.setSetting("cookiesBrowser", $("#suCookies").value);
    SETTINGS.setSetting("downloadDir", $("#suDlDir").value.trim());
    SETTINGS.setSetting("preferLocal", $("#suPrefLocal").checked);
    SETTINGS.setSetting("autoSaveImports", $("#suAutoSave").checked);
    SETTINGS.setSetting("notifyOnChange", $("#suNotify").checked);
    finishSetup();
    ytConfigPush().catch(() => {});
  });
}

// Follow management rows inside the Settings modal.
function renderFollowList() {
  const host = $("#setFollowList");
  if (!host) return;
  if (!follows.length) { host.innerHTML = `<div class="set-hint">No followed playlists yet.</div>`; return; }
  const pls = PL.getPlaylists();
  host.innerHTML = follows.map(f => `
    <div class="fl-row" title="${esc(f.url)}">
      <label class="fl-on" title="Enabled"><input type="checkbox" data-fl-on="${f.id}" ${f.enabled !== false ? "checked" : ""}></label>
      <span class="fl-name">${esc(f.title)}</span>
      <select class="sel fl-target" data-fl-target="${f.id}" title="Add new tracks to this playlist">
        ${pls.map(p => `<option value="${p.id}" ${f.playlistId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        ${pls.some(p => p.id === f.playlistId) ? "" : `<option value="" selected>(playlist deleted)</option>`}
      </select>
      <label class="fl-dl" title="Auto-download new tracks to the library"><input type="checkbox" data-fl-dl="${f.id}" ${f.autoDownload ? "checked" : ""}> ${ic(IC.save)}</label>
      <button class="fl-x" data-fl-x="${f.id}" title="Unfollow">${IC.x}</button>
    </div>`).join("");
  const byId = (id) => follows.find(f => f.id === id);
  host.querySelectorAll("[data-fl-on]").forEach(el => el.addEventListener("change", e => { const f = byId(el.dataset.flOn); if (f) { f.enabled = e.target.checked; saveFollows(); renderPlaylists(); } }));
  host.querySelectorAll("[data-fl-target]").forEach(el => el.addEventListener("change", e => { const f = byId(el.dataset.flTarget); if (f && e.target.value) { f.playlistId = e.target.value; saveFollows(); renderPlaylists(); } }));
  host.querySelectorAll("[data-fl-dl]").forEach(el => el.addEventListener("change", e => { const f = byId(el.dataset.flDl); if (f) { f.autoDownload = e.target.checked; saveFollows(); } }));
  host.querySelectorAll("[data-fl-x]").forEach(el => el.addEventListener("click", async () => {
    if (!await askConfirm("Unfollow this playlist?", "Already-added tracks are kept.", "Unfollow")) return;
    follows = follows.filter(f => f.id !== el.dataset.flX);
    saveFollows(); renderFollowList(); renderPlaylists();
  }));
}

// Open/close the mobile sidebar overlay. Opening it closes any open modal so
// windows don't stack on top of each other ("suraffiche").
function toggleSidebar(force) {
  const open = force === undefined ? !document.body.classList.contains("side-open") : force;
  document.body.classList.toggle("side-open", open);
  $("#sideBackdrop").hidden = !open;
  if (open) closeAllModals();
}
// Close every modal/drawer overlay — the single "dismiss everything" used when a
// higher-priority window takes over, so nothing lingers behind it.
function closeAllModals() {
  document.querySelectorAll(".modal-backdrop:not([hidden])").forEach(m => { m.hidden = true; });
  if (typeof _extBusy !== "undefined") { /* leave a busy import running in bg */ }
}

// ─── Resizable panels (sidebar / Now-playing) ───────────────────────────────
// Pointer-drag the handles; the width lives in a CSS var and persists as a
// setting. Double-click a handle to reset that panel to its default width.
function wireResizer(handle, { min, max, def, setting, cssVar, widthFrom }) {
  const el = $(handle);
  if (!el) return;
  const root = document.documentElement.style;
  let raf = 0, lastW = 0;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    document.body.classList.add("rs-dragging");
    const move = (ev) => {
      const w = Math.round(Math.min(max, Math.max(min, widthFrom(ev))));
      if (w === lastW) return;
      lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => root.setProperty(cssVar, `${w}px`));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      document.body.classList.remove("rs-dragging");
      if (lastW) SETTINGS.setSetting(setting, lastW);
      updateNpPush(); // a new width can tip the drawer between push and overlay
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  el.addEventListener("dblclick", () => {
    root.setProperty(cssVar, `${def}px`);
    SETTINGS.setSetting(setting, def);
    updateNpPush(); // a new width can tip the drawer between push and overlay
    flash("Panel width reset");
  });
}
function initResizers() {
  wireResizer("#sideResize", {
    min: 190, max: 480, def: 268, setting: "sideW", cssVar: "--side-w",
    widthFrom: (ev) => ev.clientX - 8, // .app left padding
  });
  wireResizer("#npResize", {
    min: 250, max: 560, def: 330, setting: "npW", cssVar: "--np-w",
    widthFrom: (ev) => window.innerWidth - 10 - ev.clientX, // drawer is right-anchored (right: 10px)
  });
}

// ─── Wire up ───
async function init() {
  hydrateIcons();
  await Promise.all([PL.initPlaylists(), SETTINGS.loadSettings(), loadOnline(), loadFollows(), loadDlBlock(), loadHistory(), loadBlocked()]);
  await loadLibrary();
  await normalizeLibraryPaths();      // heal /home vs /var/home aliases + drop duplicates
  if (IS_ANDROID && !folders.length) {
    // Give the permission dialog a moment, then adopt the shared Music folder.
    setTimeout(() => { addSource(ANDROID_MUSIC_DIR).catch(() => {}); }, 4000);
  }
  if (enrichLibrary()) saveLibrary();
  const relinked = relinkPlaylists(); // heal playlist paths after moved/re-added music
  if (relinked) flash(`Relinked ${relinked} moved track${relinked === 1 ? "" : "s"}`);

  if (!IS_NATIVE) {
    const banner = document.createElement("div");
    banner.className = "mock-banner";
    banner.textContent = "Browser preview (mock data, no audio). Run the app for real playback.";
    $(".main").prepend(banner);
    if (!library.length) { library = MOCK_TRACKS; folders = ["/demo"]; }
  }

  wireTrackList();
  initResizers();
  // Small screens (Android/narrow windows): the sidebar is an overlay behind ☰,
  // with a full-screen backdrop so a modal opened underneath can't bleed through.
  $("#sideToggle").addEventListener("click", () => toggleSidebar());
  $("#sideBackdrop").addEventListener("click", () => toggleSidebar(false));
  $(".sidebar").addEventListener("click", (e) => {
    if (window.innerWidth <= 700 && e.target.closest(".nav-item, .pl-row, .src-row")) toggleSidebar(false);
  });
  $("#pickBtn").addEventListener("click", pickFolder);
  $("#manualBtn").addEventListener("click", addManual);
  $("#rescanBtn").addEventListener("click", rescanAll);
  $("#navLibrary").addEventListener("click", showLibrary);
  $("#navHistory").addEventListener("click", showHistory);

  $("#playBtn").addEventListener("click", togglePlay);
  $("#nextBtn").addEventListener("click", next);
  $("#prevBtn").addEventListener("click", prev);
  $("#shuffleBtn").addEventListener("click", () => { shuffle = !shuffle; $("#shuffleBtn").classList.toggle("active", shuffle); if (shuffle) buildShuffle(curIndex); if (curIndex >= 0) schedulePreload(); renderNpPanel(); flash(shuffle ? "Shuffle on" : "Shuffle off"); });
  $("#repeatBtn").addEventListener("click", () => {
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    SETTINGS.setSetting("repeatDefault", repeatMode);
    updateRepeatBtn();
    if (curIndex >= 0) schedulePreload();
    flash(repeatMode === "off" ? "Repeat off" : repeatMode === "all" ? "Repeat all" : "Repeat one");
  });
  let _volT = null;
  $("#volume").addEventListener("input", e => {
    invoke("set_volume", { level: Number(e.target.value) / 100 });
    e.target.style.setProperty("--fill", `${e.target.value}%`);
    clearTimeout(_volT); _volT = setTimeout(() => SETTINGS.setSetting("defaultVolume", Number(e.target.value)), 400);
  });

  $("#seek").addEventListener("input", () => { seeking = true; $("#curTime").textContent = fmtDur(Number($("#seek").value)); });
  $("#seek").addEventListener("change", async () => {
    const s = Number($("#seek").value); await invoke("seek", { secs: s }); wallSeek(s); seeking = false; renderSeek(s); mediaPlayback();
    // Refresh the presence only if one is (or should be) shown: while playing,
    // or while the temporary "Paused" card is still up. Never resurrect a
    // presence that rpcPause/rpcStop already cleared.
    if (playing || _rpcPauseTimer) updateRPC(trackByPath(effectivePath(queue[curIndex]) || "") || trackByPath(queue[curIndex]), playing);
  });

  $("#search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    selected.clear();
    if (!q) { refreshView(); return; }
    // Search WITHIN the current view (playlist / folder / library), all words
    // must match somewhere in title+artist+album.
    let scope = "library", list = library;
    if (active.type === "playlist") {
      const pl = PL.getPlaylists().find(p => p.id === active.id);
      if (pl) {
        const by = new Map(library.map(t => [t.path, t]));
        list = pl.paths.map(p => by.get(p) || ensureOnlineTrack(p)).filter(Boolean);
        scope = `“${pl.name}”`;
      }
    } else if (active.type === "source") {
      list = library.filter(t => inFolder(t, active.id));
      scope = baseName(active.id);
    }
    const words = q.split(/\s+/).filter(Boolean);
    const hits = list.filter(t => {
      const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
    setViewHead({ icon: IC.search, title: "Search", subtitle: `“${e.target.value.trim()}” in ${scope} · ${hits.length} match${hits.length === 1 ? "" : "es"} — Enter searches YouTube` });
    renderTracks(hits);
  });
  $("#search").addEventListener("keydown", e => { if (e.key === "Enter") searchOnline(e.target.value.trim()); });

  $("#importBtn").addEventListener("click", openImportPick);
  $("#pickClose").addEventListener("click", () => $("#pickModal").hidden = true);
  $("#pickModal").addEventListener("click", e => { if (e.target.id === "pickModal") $("#pickModal").hidden = true; });
  $("#pickYt").addEventListener("click", () => { $("#pickModal").hidden = true; openImport(); });
  $("#pickSp").addEventListener("click", () => { $("#pickModal").hidden = true; openExtImport(); });
  $("#extClose").addEventListener("click", () => { if (!_extBusy) $("#extModal").hidden = true; });
  $("#extModal").addEventListener("click", e => { if (e.target.id === "extModal" && !_extBusy) $("#extModal").hidden = true; });
  $("#extGo").addEventListener("click", runExtImport);
  $("#extCancel").addEventListener("click", () => { _extCancel = true; extStatus("Stopping…"); });
  $("#importClose").addEventListener("click", () => $("#importModal").hidden = true);
  $("#importModal").addEventListener("click", e => { if (e.target.id === "importModal") $("#importModal").hidden = true; });
  $("#plDetailClose").addEventListener("click", closePlaylistDetail);
  $("#plDetailModal").addEventListener("click", e => { if (e.target.id === "plDetailModal") closePlaylistDetail(); });
  $("#plDetailImport").addEventListener("click", () => importPlaylistDetail(true));
  $("#navShare").addEventListener("click", openShare);
  // Sources dropdown (topbar): toggle on click, close on outside click / Esc.
  $("#navSources")?.addEventListener("click", e => {
    e.stopPropagation();
    const d = $("#srcDrop");
    d.hidden = !d.hidden;
    $("#navSources").classList.toggle("active", !d.hidden);
  });
  document.addEventListener("click", e => {
    const d = $("#srcDrop");
    if (!d || d.hidden) return;
    if (!e.target.closest(".top-drop-wrap")) { d.hidden = true; $("#navSources").classList.remove("active"); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { const d = $("#srcDrop"); if (d && !d.hidden) { d.hidden = true; $("#navSources").classList.remove("active"); } }
  });
  smoothWheel($("#trackList"));
  smoothWheel(document.querySelector(".sidebar"));
  $("#shareClose").addEventListener("click", () => $("#shareModal").hidden = true);
  $("#shareModal").addEventListener("click", e => { if (e.target.id === "shareModal") $("#shareModal").hidden = true; });
  $("#shareHostStart").addEventListener("click", shareHostStart);
  $("#shareHostStop").addEventListener("click", shareHostStop);
  $("#shareConnect").addEventListener("click", shareConnect);
  $("#impFetch").addEventListener("click", impFetch);
  $("#impUrl").addEventListener("keydown", e => { if (e.key === "Enter") impFetch(); });
  $("#impSearch").addEventListener("click", impSearchGo);
  $("#impQuery").addEventListener("keydown", e => { if (e.key === "Enter") impSearchGo(); });

  $("#sideFilter").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#sourcesList .src-row, #playlistsList .pl-row[data-pl]").forEach(el => {
      el.hidden = !!q && !el.textContent.toLowerCase().includes(q);
    });
  });
  $("#impAll").addEventListener("click", () => { document.querySelectorAll("#impList [data-imp]").forEach(c => c.checked = true); updateImpCount(); });
  $("#impNone").addEventListener("click", () => { document.querySelectorAll("#impList [data-imp]").forEach(c => c.checked = false); updateImpCount(); });
  $("#impList").addEventListener("change", updateImpCount);
  $("#impFollow").addEventListener("change", updateImpCount);
  $("#impGo").addEventListener("click", impGo);
  $("#dlAction").addEventListener("click", dlStop);
  $("#dlRetry").addEventListener("click", dlRetry);
  $("#dlRetryBlocked").addEventListener("click", dlRetryBlocked);
  $("#dlToggle").addEventListener("click", () => { dlOpen = !dlOpen; if (dlOpen && npOpen) toggleNpPanel(false); dlRender(); });
  $("#dlClose").addEventListener("click", () => { dlOpen = false; dlRender(); });

  sortMode = S().sortMode || "default";
  $("#sortSel").value = sortMode;
  $("#sortSel").addEventListener("change", e => { sortMode = e.target.value; SETTINGS.setSetting("sortMode", sortMode); refreshView(); });
  $("#listRefreshBtn")?.addEventListener("click", refreshActiveViewAction);

  document.querySelector(".now").addEventListener("click", () => toggleNpPanel());
  // Right-clicking the playing track (bottom bar or the Now Playing panel)
  // selects it and opens the SAME context menu as a playlist row — so the
  // current track can be downloaded/blocked/deleted without hunting for its
  // row in the list.
  const ctxOnPlaying = (e) => {
    const p = curIndex >= 0 ? queue[curIndex] : null;
    if (!p) return;
    e.preventDefault();
    selected.clear(); selected.add(p);
    anchorIdx = view.findIndex(t => t.path === p);
    refreshSelectionUI();
    openContextMenu(e.clientX, e.clientY);
  };
  document.querySelector(".now").addEventListener("contextmenu", ctxOnPlaying);
  for (const sel of ["#ovArt", "#ovTitle", "#ovSub", "#ovMeta"]) $(sel).addEventListener("contextmenu", ctxOnPlaying);
  $("#npClose").addEventListener("click", () => toggleNpPanel(false));
  $("#npPin").addEventListener("click", () => { SETTINGS.setSetting("npDocked", !S().npDocked); applyUiPrefs(); });
  document.querySelectorAll(".ss-toggle").forEach(el => el.addEventListener("click", () => {
    const key = el.dataset.coll;
    SETTINGS.setSetting(key, !S()[key]);
    applyUiPrefs();
  }));
  wireDialogs();
  wireCookieConsent();

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", () => $("#settingsModal").hidden = true);
  $("#settingsModal").addEventListener("click", e => { if (e.target.id === "settingsModal") $("#settingsModal").hidden = true; });

  window.addEventListener("blur", () => document.body.classList.add("win-blur"));
  window.addEventListener("beforeunload", savePlayback); // best-effort save on close
  window.addEventListener("focus", () => document.body.classList.remove("win-blur"));

  // Never show the WebView's native right-click menu (Reload etc.) — custom
  // menus only; text fields keep their native copy/paste menu.
  document.addEventListener("contextmenu", e => { if (!e.target.closest("input, textarea")) e.preventDefault(); });

  document.addEventListener("click", e => { if (!e.target.closest("#ctxMenu") && e.target.dataset.more === undefined) closeCtx(); });
  document.addEventListener("scroll", closeCtx, true);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (_dlgResolve) { dlgClose(_dlgHasInput ? null : false); return; }
    closeCtx(); $("#settingsModal").hidden = true; $("#importModal").hidden = true;
    if (dlOpen) { dlOpen = false; dlRender(); }
    if (npOpen) toggleNpPanel(false);
  });

  renderPlaylists();
  applySettings();
  listenMediaEvents();
  listenDlEvents();
  startPolling();
  startProgressLoop();
  initSmoothScroll();
  showLibrary();
  await restorePlayback();   // restore last track (paused) where we left off
  resumeDownloads();         // re-queue downloads that hadn't finished

  wireSetup();
  if (IS_NATIVE && !S().setupDone) openSetup();
  else ytConfigPush().catch(() => {}); // warm up detection with saved prefs
  checkUpdate();

  if (S().uiNpOpen) toggleNpPanel(true); // restore the up-next panel

  // Followed playlists: one check shortly after launch (let the app settle),
  // then periodically according to the configured interval.
  setTimeout(() => checkFollows(), 20000);
  setInterval(() => checkFollows(false, true), 15 * 60 * 1000);

  // Cloud sync: restore tokens, then auto-pull on launch (and periodically).
  await gdriveRestore();
  if (S().gdriveTokens?.refresh_token && S().syncAuto !== false) {
    setTimeout(() => syncPull(true), 6000);
    setInterval(() => syncNow(), 10 * 60 * 1000);
  }
}

init().catch(e => console.error("[init] failed:", e));



