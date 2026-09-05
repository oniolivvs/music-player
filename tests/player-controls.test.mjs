import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clampSeekPercent,
  clampVolumePercent,
  seekPercentForSeconds,
  seekSecondsForPercent,
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

test("volume percentage clamps to the 0–100 range", () => {
  assert.equal(clampVolumePercent(-4), 0);
  assert.equal(clampVolumePercent(45.5), 45.5);
  assert.equal(clampVolumePercent(140), 100);
  assert.equal(clampVolumePercent("bad"), 0);
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

test("UI customization exposes layout and player visibility controls", async () => {
  const settings = await readFile(new URL("../src/settings.js", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(settings, /uiLayout:\s*["']balanced["']/);
  for (const key of ["uiNavStats", "uiNavShare", "uiPlayerShuffle", "uiPlayerRepeat", "uiPlayerVolume", "uiPlayerProgress"]) {
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
