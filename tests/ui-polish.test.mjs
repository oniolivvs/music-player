import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("playlist sidebar has no legacy import button", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="importBtn"/);
  assert.match(html, /id="importModal"/);
});

test("hot bar owns playlist import and Share is absent from the UI", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(html, /id="importPlaylistBtn"[^>]*>[\s\S]*?Import playlist/);
  assert.doesNotMatch(html, /id="navShare"|id="shareModal"|>Share<\/span>/);
  assert.doesNotMatch(main, /uiNavShare|#navShare/);
});

test("playlist import explicitly asks whether future tracks should be followed", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(html, /Follow future tracks\?/);
  assert.match(html, /class="imp-foot-row imp-import-actions"[\s\S]*class="follow-choice-options"[\s\S]*id="impDl"/);
  assert.match(html, /id="impFollowNo"[^>]*checked/);
  assert.match(html, /id="impFollowYes"/);
  assert.match(css, /\.imp-import-actions\s*\{[^}]*align-items:\s*flex-end/s);
  assert.match(css, /\.imp-import-actions \.imp-dl\s*\{[^}]*min-height:\s*34px/s);
  assert.doesNotMatch(html, /id="pickJson"/);
});

test("Now Playing uses a large non-stretched hero artwork", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(html, /class="ov-copy"[\s\S]*id="ovTitle"[\s\S]*id="ovSub"[\s\S]*id="ovMeta"/);
  assert.match(css, /\.ov-art\s*\{[^}]*aspect-ratio:\s*16 \/ 9[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.ov-art\.has-cover::before[\s\S]*z-index:\s*0[^}]*background-size:\s*cover[^}]*filter:\s*blur\(16px\)/);
  assert.match(css, /\.ov-art\.has-cover::after[\s\S]*inset:\s*0[^}]*background-size:\s*contain/);
  assert.match(css, /\.ov-copy\s*\{[^}]*backdrop-filter:\s*blur\(12px\)/s);
  assert.match(css, /\.ov-title\s*\{[^}]*color:\s*var\(--tx-1\)[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.ov-sub, \.ov-meta\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.np-next-head\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(main, /function paintArtImage\(el, url\)[\s\S]*--ov-art-image/);
  assert.match(main, /FIT_EXEMPT = \[[^\]]*"ov-art"/);
  assert.doesNotMatch(main, /function sizeNowPlayingArt/);
});

test("settings expose one unified backup import and export", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(main, /id="setBackupExport"/);
  assert.match(main, /id="setBackupImport"/);
  assert.match(main, /class="data-transfer-actions paired-actions"/);
  assert.doesNotMatch(main, /id="setMusicListImport"/);
  assert.match(main, /try \{ backup = parseBackup\(raw\); \}[\s\S]*await importJsonMusicList\(raw, path\)/);
  assert.match(html, /class="setup-actions paired-actions"/);
  assert.match(css, /\.paired-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.paired-actions\s*>\s*button\s*\{[^}]*width:\s*100%[^}]*min-height:\s*46px/s);
  assert.match(main, /createBackup\(\{/);
  assert.match(main, /parseBackup\(/);
});

test("settings navigation includes APIs and Providers before storage", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const nav = main.match(/<nav class="set-nav">([\s\S]*?)<\/nav>/)?.[1] || "";
  assert.deepEqual([...nav.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]), ["interface", "appearance", "providers", "dependencies", "disk", "data", "system"]);
  assert.match(nav, /Customisation[\s\S]*Interface[\s\S]*Appearance[\s\S]*APIs &amp; Providers[\s\S]*Dependencies[\s\S]*Disk[\s\S]*Backup[\s\S]*System/);
  assert.doesNotMatch(nav, /Playback|YouTube|Downloads|Library/);
  assert.doesNotMatch(main, /id="setSignIn"|Sign in with Google/);
  assert.match(main, /data-pane="disk"[\s\S]*id="setDlDir"[\s\S]*id="setSharedDir"[\s\S]*id="setAutoSave"/);
  assert.doesNotMatch(main.match(/data-pane="disk"([\s\S]*?)<\/section>/)?.[1] || "", /setDlQuality|setDlConcurrency|setResumeDl|setCookies|setYtPath/);
  const system = main.match(/data-pane="system"([\s\S]*?)<\/section>/)?.[1] || "";
  for (const id of ["setCurVer", "setUpdCheck", "diagList", "diagExport"]) assert.match(system, new RegExp(`id="${id}"`));
});

test("dependency center reports and repairs yt-dlp, FFmpeg and FFprobe", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/settings.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/youtube.rs", import.meta.url), "utf8");
  const pane = main.match(/data-pane="dependencies"([\s\S]*?)<\/section>/)?.[1] || "";
  for (const id of ["dependencyList", "dependencyRefresh", "dependencyInstallAll", "setDepCheck", "setDepAuto"]) assert.match(pane, new RegExp(`id="${id}"`));
  assert.match(main, /invoke\("dependency_status"\)[\s\S]*invoke\("dependency_install", \{ dependency \}\)/);
  assert.match(settings, /dependencyCheckOnLaunch:\s*true[\s\S]*autoInstallDependencies:\s*true/);
  assert.match(rust, /struct DependencyReport[\s\S]*pub async fn dependency_status[\s\S]*pub async fn dependency_install/);
  assert.match(html, /id="suDependencyList"[\s\S]*id="suDepInstallAll"[\s\S]*id="suAutoFollow"[\s\S]*id="suAutoDeps"/);
});

test("playlist automation defaults are configurable and applied during import", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/settings.js", import.meta.url), "utf8");
  assert.match(settings, /autoFollowImports:\s*false[\s\S]*autoDownloadFollows:\s*false/);
  for (const id of ["setAutoFollow", "setFollowAutoDl", "setFollowIv", "setNewTracks", "setResumeDl"]) assert.match(main, new RegExp(`id="${id}"`));
  assert.match(main, /alreadyFollowed \|\| S\(\)\.autoFollowImports/);
  assert.match(main, /autoDownload: \$\("#impDl"\)\.checked \|\| S\(\)\.autoDownloadFollows/);
});

test("provider settings expose protected Spotify credentials and validated yt-dlp options", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/settings.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/youtube.rs", import.meta.url), "utf8");
  const pane = main.match(/data-pane="providers"([\s\S]*?)<\/section>/)?.[1] || "";
  assert.match(pane, /type="password" id="setSpotifyId"/);
  assert.match(pane, /type="password" id="setSpotifySecret"/);
  assert.match(pane, /Spotify Developer Dashboard[\s\S]*id="setYtPath"[\s\S]*id="setDlQuality"[\s\S]*id="setYtArgs"/);
  assert.match(settings, /spotifyClientId:\s*""[\s\S]*spotifyClientSecret:\s*""[\s\S]*ytdlpArgs:\s*""/);
  assert.match(main, /clientId:\s*S\(\)\.spotifyClientId[\s\S]*clientSecret:\s*S\(\)\.spotifyClientSecret/);
  assert.match(main, /spotifyClientId: _spotifyId, spotifyClientSecret: _spotifySecret/);
  assert.match(rust, /fn parse_custom_args[\s\S]*Custom yt-dlp option is managed or unsafe/);
});

test("scrolling is native and stats spotlight clips every text column", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(main, /function _smStep|delta \* step|_sm\.target/);
  assert.match(main, /function onWheelSmooth[\s\S]*modal\.contains\(el\)[\s\S]*\}\n/);
  assert.match(css, /body\.smooth \.tracklist[\s\S]*scroll-behavior:\s*smooth/);
  assert.match(css, /\.st-spotlight\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.st-spotlight > \*\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/s);
});

test("playlist storage supports folder selection, physical moves, and shared-file reuse", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const playlists = await readFile(new URL("../src/playlists.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/library.rs", import.meta.url), "utf8");
  assert.match(html, /id="dlgSaveLocal"/);
  assert.match(main, /function pickMusicDirectory/);
  assert.match(main, /data-move="1"/);
  assert.match(main, /id="plMoveBtn"/);
  assert.match(main, /invoke\("move_audio_file"/);
  assert.match(main, /PL\.replaceMany\(pathMap\)/);
  assert.match(main, /Smart pointer deduplication/);
  assert.match(main, /fs_exists[\s\S]*PL\.replacePath\(d\.path, shared\)/);
  assert.match(playlists, /function createPlaylist\(name, downloadDir = ""\)/);
  assert.match(playlists, /export function setDownloadDir/);
  assert.match(rust, /pub async fn move_audio_file/);
});

test("playlist appearance persists banners, cover sync, opacity and custom indicators", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const playlists = await readFile(new URL("../src/playlists.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(html, /id="plVisualModal"/);
  assert.match(html, /id="plCoverMode"[\s\S]*value="first"[\s\S]*value="last"[\s\S]*value="custom"/);
  assert.match(playlists, /export function setVisuals/);
  for (const key of ["bannerImage", "followImage", "localImage", "coverMode", "imageOpacity"]) assert.match(playlists, new RegExp(key));
  assert.match(main, /function applyPlaylistBanner/);
  assert.match(main, /mode === "last" \? \[\.\.\.pl\.paths\]\.reverse\(\)/);
  assert.match(css, /\.view-head\.has-playlist-banner::before/);
});

test("UI scaling resizes the full canvas without clipping it", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /document\.body\.style\.zoom/);
  assert.match(main, /document\.body\.style\.width = IS_ANDROID \? "" : `\$\{10000 \/ uiScale\}%`/);
  assert.match(main, /document\.body\.style\.height = IS_ANDROID \? "" : `\$\{10000 \/ uiScale\}vh`/);
});

test("volume percentage is rendered inside one bordered field", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(html, /class="volume-pct"[\s\S]*class="volume-pct-sign"/);
  assert.match(css, /\.volume-pct\s*\{[^}]*border:/);
  assert.match(css, /\.volume-pct-sign\s*\{[^}]*position:\s*absolute/);
});

test("text fields keep a visible border over artwork and popup glass", async () => {
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /--field-border:/);
  assert.match(css, /body\.has-bg[\s\S]*input\[type="text"\][\s\S]*border-color:\s*var\(--field-border\)/);
  assert.match(css, /\.modal[\s\S]*backdrop-filter:\s*blur\(var\(--ui-panel-blur/);
});

test("every layout keeps the hot bar full width and aligns Now Playing below it", async () => {
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /body\.artwork-theme\.has-bg \.nav-bar[\s\S]*margin:/);
  assert.match(css, /body\.artwork-theme\.has-bg :where\(\.sidebar, \.main, \.np-drawer\)[\s\S]*gap|border:/);
  assert.match(css, /body\.artwork-theme\.has-bg\.np-push \.app\s*\{[^}]*margin-right:\s*calc\(var\(--np-eff,[^}]*\+\s*8px/s);
  assert.match(css, /body\.artwork-theme\.has-bg \.np-drawer\s*\{[^}]*top:\s*calc\(var\(--nav-bottom,\s*56px\)\s*\+\s*var\(--shell-gap,\s*12px\)\)/s);
  assert.match(css, /\.np-drawer\s*\{[^}]*top:\s*calc\(var\(--nav-bottom,\s*56px\)\s*\+\s*var\(--shell-gap,\s*12px\)\)/s);
  assert.match(css, /body\.artwork-theme\.has-bg \.np-drawer\s*\{[^}]*right:\s*calc\(8px\s*\+\s*var\(--safe-right,\s*0px\)\)/s);
  assert.match(css, /body\.artwork-theme\.has-bg \.np-drawer\s*\{[^}]*bottom:\s*calc\(var\(--player-top,\s*118px\)\s*\+\s*8px\)/s);
  assert.match(css, /\.rs-handle::after\s*\{[^}]*left:\s*3px;[^}]*width:\s*2px;[^}]*opacity:\s*0;/s);
  assert.match(css, /\.rs-handle:hover::after[^}]*opacity:\s*1;/s);
  assert.doesNotMatch(css, /body\.artwork-theme\.has-bg[^}]*\.nav-bar\s*\{[^}]*margin-right:\s*calc\(var\(--np-eff/s);
});

test("hot bar actions keep natural widths with equal gaps except Settings", async () => {
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.nav-bar\s*\{[^}]*gap:\s*10px/s);
  assert.match(css, /\.top-nav > \.nav-item:not\(\.nav-right\),\s*\.top-nav > \.top-drop-wrap\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.top-nav \.nav-right\s*\{[^}]*margin-left:\s*auto/s);
  assert.doesNotMatch(css, /\.top-nav > \.nav-item:not\(\.nav-right\),\s*\.top-nav > \.top-drop-wrap\s*\{[^}]*flex:\s*1 1 0/s);
  assert.match(css, /:where\(\.btn, \.btn-line, \.icon-btn, \.ctrl, \.nav-item, \.set-tab\):not\(:disabled\):hover\s*\{[^}]*translateY\(-2px\)/s);
  assert.match(css, /\.btn\.timer-armed::before\s*\{[^}]*animation:\s*button-countdown 5s linear forwards/s);
});

test("expected artwork and optional feed fallbacks do not pollute error logs", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const youtube = await readFile(new URL("../src-tauri/src/youtube.rs", import.meta.url), "utf8");
  assert.match(main, /diagnostics\.record\("debug", "theme", "artwork_retained"/);
  assert.match(main, /diagnostics\.record\("debug", "feed", `\$\{sec\.id\}_unavailable`/);
  assert.match(main, /diagnostics\.record\("info", "library", "duplicates_merged"/);
  assert.doesNotMatch(youtube, /youtube\.com\/feed\/trending/);
  assert.match(youtube, /yt_search\(cfg, query, Some\(n\), Some\(0\)\)\.await/);
});
