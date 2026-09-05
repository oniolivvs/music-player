import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clampSeekPercent,
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

test("seek percentage input is exposed beside the song bar", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /id="seekPct"[^>]*type="number"/);
  assert.match(html, /class="seek-pct-sign"/);
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
