import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clampSeekPercent,
  clampVolumePercent,
  seekPercentForSeconds,
  seekSecondsForPercent,
  volumeGainFromPercent,
} from "../src/player-controls.mjs";

test("seek percent converts to seconds and clamps safely", () => {
  assert.equal(seekSecondsForPercent(25, 200), 50);
  assert.equal(seekSecondsForPercent(-5, 200), 0);
  assert.equal(seekSecondsForPercent(120, 200), 200);
  assert.equal(seekSecondsForPercent("bad", 200), 0);
});

test("seek seconds converts back to a bounded percentage", () => {
  assert.equal(seekPercentForSeconds(50, 200), 25);
  assert.equal(seekPercentForSeconds(-2, 200), 0);
  assert.equal(seekPercentForSeconds(300, 200), 100);
  assert.equal(seekPercentForSeconds(10, 0), 0);
});

test("song progress bar has no volume percentage field", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /seekPct|seek-pct/);
  const progress = html.match(/<div class="progress">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.doesNotMatch(progress, /type="number"|%/);
});

test("volume percentage field is beside the volume slider without native arrows", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const volume = html.match(/<div class="volume">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.match(volume, /id="volumePct"[^>]*type="number"/);
  assert.match(volume, /class="volume-pct-sign"/);
  assert.match(stylesheet, /\.volume-pct input\s*\{[^}]*appearance:\s*textfield/);
  assert.match(stylesheet, /\.volume-pct input::-webkit-inner-spin-button\s*,\s*\.volume-pct input::-webkit-outer-spin-button/);
  assert.match(stylesheet, /-webkit-appearance:\s*none/);
});

test("volume percentage field keeps its interior transparent", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.volume-pct input\s*\{[^}]*background:\s*transparent/);
});

test("volume percentage clamps to the 0–100 range", () => {
  assert.equal(clampVolumePercent(-4), 0);
  assert.equal(clampVolumePercent(45.5), 45.5);
  assert.equal(clampVolumePercent(140), 100);
  assert.equal(clampVolumePercent("bad"), 0);
});

test("volume uses a perceptual taper with useful low-volume travel", () => {
  assert.equal(volumeGainFromPercent(0), 0);
  assert.equal(volumeGainFromPercent(25), 0.015625);
  assert.equal(volumeGainFromPercent(50), 0.125);
  assert.equal(volumeGainFromPercent(100), 1);
  assert.equal(volumeGainFromPercent(140), 1);
});

test("volume percentage updates the volume control rather than seeking", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /#volumePct/);
  assert.match(main, /set_volume/);
  assert.doesNotMatch(main, /#seekPct|seekSecondsForPercent/);
});

test("the hot bar shares the adaptive panel blur", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /--ui-panel-blur:\s*[^;]+;/);
  assert.match(stylesheet, /body\.has-bg \.player[\s\S]*?backdrop-filter:\s*blur\(var\(--ui-panel-blur/);
  assert.match(stylesheet, /body\.has-bg \.modal,[\s\S]*?backdrop-filter:\s*blur\(var\(--ui-panel-blur/);
});

test("shuffle search defaults to the current playlist or library scope", async () => {
  const settings = await readFile(new URL("../src/settings.js", import.meta.url), "utf8");
  assert.match(settings, /shuffleSearchOnly:\s*false/);
});

test("shuffle and repeat expose unmistakable active states", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(html, /id="shuffleBtn"[^>]*state-ctrl[^>]*aria-pressed="false"/);
  assert.match(html, /id="repeatBtn"[^>]*state-ctrl[^>]*aria-pressed="false"/);
  assert.match(main, /function updateShuffleBtn\(\)[\s\S]*aria-pressed/);
  assert.match(main, /function updateRepeatBtn\(\)[\s\S]*aria-pressed/);
  assert.match(stylesheet, /\.ctrl\.state-ctrl\.active[\s\S]*linear-gradient[\s\S]*box-shadow/);
});

test("track handoff resets the clock, buffer, timer and previous artwork immediately", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /function updateNowPlaying\(t, path\)[\s\S]*?else \{ setCurrentArtwork\("", artworkToken\); fetchCover\(t\); \}/);
  assert.match(main, /function hardPlay\(i\)\s*\{[\s\S]*?commitPlay\(\);[\s\S]*?wallStart\(0\);/);
  assert.match(main, /sk\.style\.setProperty\("--buf", "0%"\); _bufPct = 0;/);
  assert.match(main, /\$\("#curTime"\)\.textContent = "0:00"; _lastTimeTxt = "0:00"; _lastSeekVal = 0;/);
  assert.match(main, /const retainReadyCover = el\.id === "npArt"[\s\S]*?el\.dataset\.album === albumKey\(t\)/);
});

test("unknown YouTube durations are hydrated and replace the one-second fallback", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const native = await readFile(new URL("../src-tauri/src/ytnative.rs", import.meta.url), "utf8");
  assert.match(main, /function hydrateOnlineDuration\(path, expectedTrack, expectedSeq\)/);
  assert.match(main, /invoke\("yt_duration", \{ id \}\)/);
  assert.match(main, /seek\.max = currentDuration;[\s\S]*renderSeek\(wallPos\(\)\)/);
  assert.match(rust, /async fn yt_duration\(id: String\)/);
  assert.match(native, /pub async fn video_duration\(id: &str\)/);
  assert.match(native, /v\["videoDetails"\]\["lengthSeconds"\]/);
  assert.match(native, /fn watch_duration\(id: &str\)/);
  assert.match(native, /approxDurationMs/);
});

test("artwork player text and controls stay readable, vivid, and frosted", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /body\.has-bg button:not\(\.swatch\)\s*\{[\s\S]*border-radius:\s*5px !important[\s\S]*background:\s*linear-gradient/);
  assert.match(stylesheet, /body\.artwork-theme\.has-bg \.track :where\(\.meta \.t, \.meta \.s, \.album, \.dur\)/);
  assert.match(stylesheet, /body\.artwork-theme \.brand > span:last-child\s*\{[^}]*-webkit-text-fill-color:\s*var\(--tx-1\)/s);
  assert.match(stylesheet, /body\.artwork-theme \.player :where\(\.now-title, \.time, \.volume-pct, \.volume-pct input\)\s*\{[^}]*var\(--tx-1\)/s);
  assert.match(stylesheet, /\.player input\[type="range"\]::-webkit-slider-runnable-track\s*\{[^}]*linear-gradient[^}]*var\(--accent-2\)[^}]*box-shadow/s);
  assert.match(stylesheet, /\.player input\[type="range"\]::-webkit-slider-thumb[\s\S]*border-radius:\s*5px[\s\S]*linear-gradient/s);
  assert.match(stylesheet, /:where\(\.btn, \.btn-line, \.icon-btn, \.ctrl, \.nav-item, \.set-tab\)\s*\{[^}]*border-radius:\s*9px[^}]*backdrop-filter:\s*blur\(14px\)/s);
  assert.match(stylesheet, /button\s*\{[^}]*border-radius:\s*9px[^}]*backdrop-filter:\s*blur\(16px\)/s);
  assert.match(stylesheet, /button\.btn-line,\s*button\.pick-opt\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(stylesheet, /button\.icon-btn,[\s\S]*button\.yc-play\s*\{[^}]*background:\s*linear-gradient/s);
});

test("UI customization exposes layout and player visibility controls", async () => {
  const settings = await readFile(new URL("../src/settings.js", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(settings, /uiLayout:\s*["']balanced["']/);
  for (const key of ["uiNavStats", "uiImportBtn", "uiPlayerShuffle", "uiPlayerRepeat", "uiPlayerVolume", "uiPlayerProgress"]) {
    assert.match(settings, new RegExp(`${key}:`));
    assert.match(main, new RegExp(key));
  }
  assert.match(main, /layout-\$\{preset\}/);
  assert.match(stylesheet, /body\.layout-focus/);
});

test("wallpaper text shadow uses the configured blur", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /--text-shadow-blur/);
  assert.match(stylesheet, /body\.has-bg\s+\.vh-title[^}]*var\(--text-shadow-blur/s);
});
