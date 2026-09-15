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
  assert.match(html, /Follow future tracks\?/);
  assert.match(html, /id="impFollowNo"[^>]*checked/);
  assert.match(html, /id="impFollowYes"/);
  assert.doesNotMatch(html, /id="pickJson"/);
});

test("settings expose full backup import and export", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(main, /id="setBackupExport"/);
  assert.match(main, /id="setBackupImport"/);
  assert.match(main, /class="data-transfer-actions triple-actions"/);
  assert.match(main, /id="setMusicListImport"/);
  assert.match(html, /class="setup-actions paired-actions"/);
  assert.match(css, /\.paired-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.paired-actions\s*>\s*button\s*\{[^}]*width:\s*100%[^}]*min-height:\s*46px/s);
  assert.match(css, /\.triple-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(main, /createBackup\(\{/);
  assert.match(main, /parseBackup\(/);
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
