import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("playlist sidebar has no legacy import button", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="importBtn"/);
  assert.match(html, /id="importModal"/);
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

test("artwork layout keeps the hot bar full width and aligns Now Playing below it", async () => {
  const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /body\.artwork-theme\.has-bg \.nav-bar[\s\S]*margin:/);
  assert.match(css, /body\.artwork-theme\.has-bg :where\(\.sidebar, \.main, \.np-drawer\)[\s\S]*gap|border:/);
  assert.match(css, /body\.artwork-theme\.has-bg\.np-push \.app\s*\{[^}]*margin-right:\s*calc\(var\(--np-eff,[^}]*\+\s*8px/s);
  assert.match(css, /body\.artwork-theme\.has-bg \.np-drawer\s*\{[^}]*top:\s*calc\(var\(--nav-bottom,\s*61px\)\s*\+\s*8px\)/s);
  assert.doesNotMatch(css, /body\.artwork-theme\.has-bg[^}]*\.nav-bar\s*\{[^}]*margin-right:\s*calc\(var\(--np-eff/s);
});
