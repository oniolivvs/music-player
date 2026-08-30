import test from "node:test";
import assert from "node:assert/strict";
import {
  paletteFromPixels,
  contrastRatio,
  cssVarsForPalette,
  createGenerationGuard,
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
