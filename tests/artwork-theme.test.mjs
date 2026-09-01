import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  paletteFromPixels,
  contrastRatio,
  cssVarsForPalette,
  artworkBackgroundStyle,
  createGenerationGuard,
  createArtworkThemeState,
} from "../src/artwork-theme.mjs";

const pixels = groups => new Uint8ClampedArray(groups.flatMap(([rgba, count]) =>
  Array.from({ length: count }, () => rgba).flat()
));

test("blue artwork yields a blue accent and readable light text", () => {
  const palette = paletteFromPixels(pixels([
    [[20, 45, 90, 255], 8],
    [[25, 90, 210, 255], 12],
    [[245, 80, 70, 255], 2],
  ]));
  assert.ok(palette.accent.b > palette.accent.r);
  assert.ok(palette.text.r >= 240 && palette.text.r < 255);
  assert.ok(palette.text.g >= 240 && palette.text.g < 255);
  assert.ok(palette.text.b >= 240 && palette.text.b < 255);
  assert.ok(contrastRatio(palette.text, palette.panel) >= 4.5);
});

test("bright artwork selects dark readable text", () => {
  const palette = paletteFromPixels(pixels([
    [[245, 230, 170, 255], 12],
    [[230, 170, 70, 255], 4],
  ]));
  assert.ok(palette.text.r > 0 && palette.text.r < 30);
  assert.ok(palette.text.g > 0 && palette.text.g < 30);
  assert.ok(palette.text.b > 0 && palette.text.b < 30);
  assert.ok(contrastRatio(palette.text, palette.panel) >= 4.5);
});

test("transparent or featureless artwork falls back", () => {
  assert.equal(paletteFromPixels(pixels([
    [[0, 0, 0, 0], 4],
    [[1, 1, 1, 255], 4],
  ])), null);
});

test("a stale artwork generation cannot win", () => {
  const guard = createGenerationGuard();
  const old = guard.next();
  const current = guard.next();
  assert.equal(guard.isCurrent(old), false);
  assert.equal(guard.isCurrent(current), true);
});

test("CSS variables are deterministic valid colors", () => {
  const palette = paletteFromPixels(pixels([[[35, 120, 210, 255], 12]]));
  const first = cssVarsForPalette(palette);
  const second = cssVarsForPalette(palette);
  assert.deepEqual(first, second);
  assert.match(first["--accent"], /^#[0-9a-f]{6}$/i);
  assert.match(first["--bg-0"], /^#[0-9a-f]{6}$/i);
  assert.match(first["--tx-1"], /^#[0-9a-f]{6}$/i);
});

test("accent text keeps normal-text contrast on artwork panels", () => {
  const palette = paletteFromPixels(pixels([[[68, 68, 102, 255], 12]]));
  assert.ok(contrastRatio(palette.accent, palette.panel) >= 4.5);
  assert.ok(contrastRatio(palette.accent2, palette.panel) >= 4.5);
});

test("dark green artwork produces a green icon surface with readable foreground", () => {
  const palette = paletteFromPixels(pixels([[[24, 132, 58, 255], 16]]));
  assert.ok(palette.iconSurface, "icon surface must be derived from artwork");
  assert.ok(palette.iconForeground, "icon foreground must be derived from artwork");
  assert.ok(palette.iconBorder, "icon border must be derived from artwork");
  assert.ok(palette.iconSurface.g > palette.iconSurface.r);
  assert.ok(palette.iconSurface.g > palette.iconSurface.b);
  assert.ok(contrastRatio(palette.iconForeground, palette.iconSurface) >= 4.5);
  const variables = cssVarsForPalette(palette);
  for (const name of ["--icon-surface", "--icon-fg", "--icon-border"]) {
    assert.match(variables[name], /^#[0-9a-f]{6}$/i);
  }
});

test("light green artwork keeps the icon treatment green and switches to dark foreground", () => {
  const palette = paletteFromPixels(pixels([[[154, 238, 174, 255], 16]]));
  assert.ok(palette.iconSurface, "icon surface must be derived from artwork");
  assert.ok(palette.iconForeground, "icon foreground must be derived from artwork");
  assert.ok(palette.iconSurface.g > palette.iconSurface.r);
  assert.ok(palette.iconSurface.g > palette.iconSurface.b);
  assert.ok(palette.iconForeground.r < palette.iconSurface.r);
  assert.ok(palette.iconForeground.g < palette.iconSurface.g);
  assert.ok(palette.iconForeground.b < palette.iconSurface.b);
  assert.ok(contrastRatio(palette.iconForeground, palette.iconSurface) >= 4.5);
});

test("artwork backgrounds fill the window by cropping instead of stretching", () => {
  assert.deepEqual(artworkBackgroundStyle("data:image/jpeg;base64,cover"), {
    image: 'url("data:image/jpeg;base64,cover")',
    size: "cover",
    position: "center",
  });
  assert.deepEqual(artworkBackgroundStyle(""), {
    image: "none",
    size: "cover",
    position: "center",
  });
});

test("the wallpaper stylesheet consumes centered cover presentation variables", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(
    stylesheet,
    /background:\s*var\(--app-bg-image, none\)\s+var\(--app-bg-position, center\)\s*\/\s*var\(--app-bg-size, cover\)\s+no-repeat;/,
  );
});

test("artwork backgrounds give shared icon controls an opaque readable surface", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const sharedRule = stylesheet.match(/body\.has-bg\s+:where\((.*?)\)\s*\{([^}]*)\}/s);
  assert.ok(sharedRule, "shared artwork icon-control rule is missing");
  assert.match(sharedRule[1], /\.icon-btn/);
  assert.match(sharedRule[1], /\.ctrl:not\(\.play\)/);
  assert.doesNotMatch(sharedRule[1], /\.ctrl\.play/);
  assert.match(sharedRule[2], /background:\s*var\(--icon-surface\)/);
  assert.match(sharedRule[2], /color:\s*var\(--icon-fg\)/);
  assert.match(sharedRule[2], /border:\s*1px solid var\(--icon-border\)/);
  assert.match(stylesheet, /body\.has-bg\s+\.sort-ico\s*\{[^}]*var\(--icon-surface\)[^}]*var\(--icon-fg\)[^}]*\}/s);
});

test("a slow previous cover cannot overwrite the current cover", async () => {
  const pending = new Map();
  const applied = [];
  const state = createArtworkThemeState({
    analyze: src => new Promise(resolve => pending.set(src, resolve)),
    apply: (src, palette) => applied.push([src, palette]),
    restore: () => applied.push(["manual"]),
  });

  const first = state.use("first");
  const second = state.use("second");
  pending.get("second")({ accent: "blue" });
  await second;
  pending.get("first")({ accent: "red" });
  await first;

  assert.deepEqual(applied, [["second", { accent: "blue" }]]);
});

test("a stale artwork rejection is ignored without restoring the manual theme", async () => {
  const pending = new Map();
  const applied = [];
  const state = createArtworkThemeState({
    analyze: src => new Promise((resolve, reject) => pending.set(src, { resolve, reject })),
    apply: (...args) => applied.push(args),
    restore: () => applied.push(["manual"]),
  });

  const first = state.use("first");
  const second = state.use("second");
  pending.get("first").reject(new Error("stale artwork failed"));

  assert.equal(await first, null);
  assert.deepEqual(applied, []);

  pending.get("second").resolve({ accent: "blue" });
  await second;
  assert.deepEqual(applied, [["second", { accent: "blue" }]]);
});

test("missing artwork restores the manual theme and invalidates pending work", async () => {
  let resolve;
  const applied = [];
  const state = createArtworkThemeState({
    analyze: () => new Promise(done => { resolve = done; }),
    apply: (...args) => applied.push(args),
    restore: () => applied.push(["manual"]),
  });

  const pending = state.use("cover");
  await state.use("");
  resolve({ accent: "late" });
  await pending;

  assert.deepEqual(applied, [["manual"]]);
});

test("cancelling artwork prevents a pending palette from being applied", async () => {
  let resolve;
  const applied = [];
  const state = createArtworkThemeState({
    analyze: () => new Promise(done => { resolve = done; }),
    apply: (...args) => applied.push(args),
    restore: () => {},
  });

  const pending = state.use("cover");
  state.cancel();
  resolve({ accent: "late" });
  await pending;

  assert.deepEqual(applied, []);
});
