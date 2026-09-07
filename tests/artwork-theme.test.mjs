import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  paletteFromPixels,
  contrastRatio,
  cssVarsForPalette,
  artworkBackgroundStyle,
  artworkBlurPx,
  artworkDimensionsAreUsable,
  artworkSourceCandidates,
  resolveArtworkSource,
  trimArtworkPaletteCache,
  artworkZoomForViewport,
  createGenerationGuard,
  createSharedArtworkPreparation,
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

test("a bright cover keeps dark text when saturated details win the accent bin", () => {
  const palette = paletteFromPixels(pixels([
    [[250, 250, 250, 255], 42],
    [[18, 58, 180, 255], 6],
  ]));
  assert.ok(palette.text.r < 30 && palette.text.g < 30 && palette.text.b < 30);
  assert.ok(contrastRatio(palette.subtle, palette.panel) >= 4.5);
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
  assert.match(first["--panel-rgb"], /^\d+ \d+ \d+$/);
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
  });
  assert.deepEqual(artworkBackgroundStyle(""), {
    image: "none",
  });
});

test("YouTube artwork requests HD variants before the universal fallback", () => {
  assert.deepEqual(
    artworkSourceCandidates("https://i.ytimg.com/vi_webp/abcdefghijk/hq720.webp?sqp=x"),
    [
      "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
      "https://i.ytimg.com/vi/abcdefghijk/hq720.jpg",
      "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
      "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
      "https://i.ytimg.com/vi_webp/abcdefghijk/hq720.webp?sqp=x",
    ],
  );
});

test("non-YouTube artwork keeps its original source", () => {
  assert.deepEqual(artworkSourceCandidates("https://covers.example/cover.jpg"), [
    "https://covers.example/cover.jpg",
  ]);
});

test("HD artwork resolver falls back in order", async () => {
  const attempted = [];
  const value = await resolveArtworkSource(
    "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
    async candidate => {
      attempted.push(candidate);
      if (!candidate.endsWith("hqdefault.jpg")) throw new Error("missing");
      return "data:image/jpeg;base64,hd";
    },
  );
  assert.equal(value, "data:image/jpeg;base64,hd");
  assert.deepEqual(attempted.map(value => value.split("/").at(-1)), [
    "maxresdefault.jpg", "hq720.jpg", "hqdefault.jpg",
  ]);
});

test("HD resolver rejects a fulfilled low-resolution placeholder", async () => {
  const attempted = [];
  const value = await resolveArtworkSource(
    "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
    async candidate => {
      attempted.push(candidate);
      return candidate.endsWith("hqdefault.jpg") ? "hd" : "placeholder";
    },
    candidate => candidate !== "placeholder",
  );
  assert.equal(value, "hd");
  assert.deepEqual(attempted.map(candidate => candidate.split("/").at(-1)), [
    "maxresdefault.jpg", "hq720.jpg", "hqdefault.jpg",
  ]);
});

test("artwork dimension guard rejects tiny YouTube placeholders", () => {
  assert.equal(artworkDimensionsAreUsable(120, 90), false);
  assert.equal(artworkDimensionsAreUsable(480, 360), true);
  assert.equal(artworkDimensionsAreUsable(1280, 720), true);
});

test("artwork palette cache is bounded by encoded image bytes", () => {
  const cache = new Map([
    ["old", { imageSrc: "1234" }],
    ["new", { imageSrc: "5678" }],
  ]);
  trimArtworkPaletteCache(cache, 5);
  assert.deepEqual([...cache.keys()], ["new"]);
});

test("the wallpaper stylesheet always centers and covers the full window", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(
    stylesheet,
    /background:\s*var\(--app-bg-image, none\)\s+center\s*\/\s*cover\s+no-repeat;/,
  );
  assert.match(stylesheet, /body::before\s*\{[^}]*inset:\s*0;/s);
  assert.doesNotMatch(stylesheet, /background:\s*var\(--app-bg-image, none\)[^;]*var\(--app-bg-size/);
});

test("artwork mode keeps layout gutters and borders", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /body\.artwork-theme\.has-bg\s+\.app\s*\{[^}]*gap:\s*8px[^}]*padding:\s*8px/s);
  assert.match(stylesheet, /body\.artwork-theme\.has-bg\s+\.nav-bar\s*\{[^}]*margin:\s*8px/s);
  assert.match(
    stylesheet,
    /body\.artwork-theme\.has-bg\s+:where\(\.sidebar, \.main, \.np-drawer\)\s*\{[^}]*border-radius:\s*var\(--r\)[^}]*border:\s*1px solid var\(--icon-border\)/s,
  );
});

test("a failed replacement retains the committed artwork", async () => {
  let restored = 0, retained = 0;
  const state = createArtworkThemeState({
    analyze: async () => { throw new Error("decode"); },
    apply() {},
    restore: async () => { restored++; },
    retain: async () => { retained++; },
  });
  await assert.rejects(state.use("next"), /decode/);
  assert.equal(retained, 1);
  assert.equal(restored, 0);
});

test("identical artwork preparations share one load", async () => {
  let resolveLoad, calls = 0;
  const prepare = createSharedArtworkPreparation(() => {
    calls++;
    return new Promise(resolve => { resolveLoad = resolve; });
  });
  const first = prepare("cover");
  const second = prepare("cover");
  assert.equal(calls, 1);
  resolveLoad("ready");
  assert.equal(await first, "ready");
  assert.equal(await second, "ready");
});

test("dynamic artwork blur stays sharp and respects lower user values", () => {
  assert.equal(artworkBlurPx(18), 6);
  assert.equal(artworkBlurPx(3), 3);
  assert.equal(artworkBlurPx(-2), 0);
  assert.equal(artworkBlurPx("invalid"), 6);
});

test("only dynamic artwork gets centered responsive zoom", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /body\.artwork-theme::before\s*\{[^}]*transform:\s*scale\(var\(--artwork-zoom/s);
  assert.match(stylesheet, /body\.artwork-theme::before\s*\{[^}]*transform-origin:\s*center/s);
  assert.doesNotMatch(stylesheet, /body\.has-bg::before\s*\{[^}]*transform:\s*scale\(1\.18\)/s);
});

test("artwork zoom increases for wide artwork in a large window without stretching", () => {
  const wide = artworkZoomForViewport(1920, 1080, 1600, 900);
  const square = artworkZoomForViewport(1000, 1000, 1600, 900);
  assert.ok(wide >= 1.2 && wide <= 1.48);
  assert.ok(square > wide, "square artwork needs extra crop for a wide window");
  assert.equal(artworkZoomForViewport(0, 0, 0, 0), 1.24);
});

test("responsive zoom fills square covers on wide windows without stretching", () => {
  const square = artworkZoomForViewport(1000, 1000, 1458, 754);
  assert.ok(square >= 1.30 && square <= 1.48, `unexpected fill zoom: ${square}`);
});

test("wide-window zoom also crops horizontal artwork margins", () => {
  const wideWindow = artworkZoomForViewport(1000, 1000, 1093, 754);
  assert.ok(wideWindow >= 1.30, `horizontal fill zoom is too small: ${wideWindow}`);
});

test("artwork zoom crops pillarboxed thumbnails to fill the full window", () => {
  const pillarboxed = artworkZoomForViewport(1280, 720, 1024, 700, 1280 / 720);
  assert.ok(pillarboxed >= 2.0 && pillarboxed <= 2.5, `expected pillarbox crop zoom: ${pillarboxed}`);
});

test("artwork theme gives every editable field palette-driven colors", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const rule = stylesheet.match(/body\.artwork-theme\s+:where\((.*?)\)\s*\{([^}]*)\}/s);
  assert.ok(rule, "artwork form-control rule is missing");
  assert.match(rule[1], /textarea/);
  assert.match(rule[1], /select/);
  assert.match(rule[1], /\.num-in/);
  assert.match(rule[2], /background:\s*var\(--bg-3\)/);
  assert.match(rule[2], /color:\s*var\(--tx-1\)/);
  assert.match(rule[2], /border-color:\s*var\(--icon-border\)/);
});

test("artwork backgrounds give shared icon controls an opaque readable surface", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  const sharedRule = [...stylesheet.matchAll(/body\.has-bg\s+:where\((.*?)\)\s*\{([^}]*)\}/gs)]
    .find(match => match[1].includes(".icon-btn"));
  assert.ok(sharedRule, "shared artwork icon-control rule is missing");
  assert.match(sharedRule[1], /\.icon-btn/);
  assert.match(sharedRule[1], /\.ctrl:not\(\.play\)/);
  assert.doesNotMatch(sharedRule[1], /\.ctrl\.play/);
  assert.match(sharedRule[2], /background:\s*var\(--icon-surface\)/);
  assert.match(sharedRule[2], /color:\s*var\(--icon-fg\)/);
  assert.match(sharedRule[2], /border:\s*1px solid var\(--icon-border\)/);
  assert.match(stylesheet, /body\.has-bg\s+\.sort-ico\s*\{[^}]*var\(--icon-surface\)[^}]*var\(--icon-fg\)[^}]*\}/s);
});

test("artwork theme colors every top navigation state from the cover palette", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /body\.artwork-theme\s+\.top-nav\s+\.nav-item\s*\{[^}]*background:\s*var\(--icon-surface\)[^}]*color:\s*var\(--icon-fg\)[^}]*border-color:\s*var\(--icon-border\)/s);
  assert.match(stylesheet, /body\.artwork-theme\s+\.top-nav\s+\.nav-item:hover\s*\{[^}]*border-color:\s*var\(--icon-fg\)/s);
  assert.match(stylesheet, /body\.artwork-theme\s+\.top-nav\s+\.nav-item\.active\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*box-shadow:/s);
});

test("blurred artwork surfaces use an adaptive text contrast shadow", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /--text-shadow-color:\s*[^;]+;/);
  assert.match(stylesheet, /body\.has-bg\s+:where\([^)]*\.sidebar[^)]*\.main[^)]*\.np-drawer[^)]*\.player[^)]*input[^)]*textarea[^)]*select[^)]*\)\s*\{[^}]*text-shadow:[^}]*var\(--text-shadow-blur/);
  assert.match(stylesheet, /text-shadow:\s*0 1px min\(2\.5px,\s*var\(--text-shadow-blur/);
  assert.match(stylesheet, /body\.bg-light\.has-bg\s*\{[^}]*--text-shadow-color:/s);
});

test("artwork hot bar uses the same palette panel tint and stronger light-scheme text", async () => {
  const stylesheet = await readFile(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /body\.artwork-theme\.has-bg\s+:where\([^)]*\.sidebar[^)]*\.player[^)]*\)\s*\{[^}]*background:\s*rgb\(var\(--panel-rgb/);
  assert.match(stylesheet, /body\.bg-light\.has-bg\s*\{[^}]*--tx-2:\s*#27303f[^}]*--tx-3:\s*#374151/s);
  assert.match(stylesheet, /body\.artwork-theme\.bg-light\s+\.brand\s+span\s*\{[^}]*-webkit-text-fill-color:\s*var\(--tx-1\)/s);
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
