const clampByte = value => Math.max(0, Math.min(255, Math.round(value)));
const rgb = (r, g, b) => ({ r: clampByte(r), g: clampByte(g), b: clampByte(b) });

function channelLuminance(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return 0.2126 * channelLuminance(color.r)
    + 0.7152 * channelLuminance(color.g)
    + 0.0722 * channelLuminance(color.b);
}

export function contrastRatio(first, second) {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

function saturation(color) {
  const max = Math.max(color.r, color.g, color.b) / 255;
  const min = Math.min(color.r, color.g, color.b) / 255;
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return 0;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

function blend(first, second, secondWeight) {
  const weight = Math.max(0, Math.min(1, secondWeight));
  return rgb(
    first.r * (1 - weight) + second.r * weight,
    first.g * (1 - weight) + second.g * weight,
    first.b * (1 - weight) + second.b * weight,
  );
}

function rgbToHsl(color) {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const lightness = (max + min) / 2;
  const sat = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  return { h: hue, s: sat, l: lightness };
}

function hslToRgb({ h, s, l }) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const offset = l - chroma / 2;
  let values;
  if (h < 60) values = [chroma, x, 0];
  else if (h < 120) values = [x, chroma, 0];
  else if (h < 180) values = [0, chroma, x];
  else if (h < 240) values = [0, x, chroma];
  else if (h < 300) values = [x, 0, chroma];
  else values = [chroma, 0, x];
  return rgb(...values.map(value => (value + offset) * 255));
}

function shiftedAccent(color, lightSurface) {
  const hsl = rgbToHsl(color);
  hsl.s = Math.max(0.45, Math.min(0.92, hsl.s));
  hsl.l = Math.max(0.26, Math.min(0.72, hsl.l + (lightSurface ? -0.12 : 0.12)));
  return hslToRgb(hsl);
}

function readableAccent(color, panel, lightSurface) {
  if (contrastRatio(color, panel) >= 4.5) return color;
  const target = lightSurface ? rgb(10, 12, 16) : rgb(250, 250, 252);
  for (const weight of [0.2, 0.35, 0.5, 0.65]) {
    const candidate = blend(color, target, weight);
    if (contrastRatio(candidate, panel) >= 4.5) return candidate;
  }
  return target;
}

export function paletteFromPixels(rgba, { allowNeutral = false, textMode = 'auto', dim = 0 } = {}) {
  if (!rgba || rgba.length < 4) return null;
  const bins = new Map();
  let visiblePixels = 0;
  let sceneLuminance = 0;
  const scene = { r: 0, g: 0, b: 0 };
  const brightness = 1 - Math.min(100, Math.max(0, Number(dim) || 0)) / 100;
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    if (rgba[index + 3] < 128) continue;
    const color = rgb(rgba[index] * brightness, rgba[index + 1] * brightness, rgba[index + 2] * brightness);
    const light = luminance(color);
    visiblePixels++;
    sceneLuminance += light;
    scene.r += color.r; scene.g += color.g; scene.b += color.b;
    if (light < 0.02 || light > 0.97) continue;
    const sat = saturation(color);
    const key = `${color.r >> 5}:${color.g >> 5}:${color.b >> 5}`;
    const bin = bins.get(key) || { count: 0, r: 0, g: 0, b: 0, saturation: 0 };
    bin.count++;
    bin.r += color.r;
    bin.g += color.g;
    bin.b += color.b;
    bin.saturation += sat;
    bins.set(key, bin);
  }

  let winner = null;
  let bestScore = -1;
  for (const bin of bins.values()) {
    const averageSaturation = bin.saturation / bin.count;
    const score = bin.count * averageSaturation;
    if (score > bestScore) {
      winner = bin;
      bestScore = score;
    }
  }
  if (!visiblePixels) return null;
  if (!winner || winner.saturation / winner.count < 0.08) {
    if (!allowNeutral) return null;
    winner = { ...scene, count: visiblePixels };
  }

  const dominant = rgb(
    winner.r / winner.count,
    winner.g / winner.count,
    winner.b / winner.count,
  );
  // Saturated details often win the accent bin even when the cover is mostly
  // white (or black). Use the whole sampled scene for the text scheme so a
  // bright background cannot leave pale labels sitting on a light glass panel.
  const averageSceneLuminance = visiblePixels ? sceneLuminance / visiblePixels : luminance(dominant);
  const lightSurface = textMode === 'dark' || (textMode !== 'light' && (luminance(dominant) > 0.55 || averageSceneLuminance > 0.58));
  const black = rgb(7, 9, 13);
  const white = rgb(250, 251, 253);
  const background = lightSurface ? blend(dominant, white, 0.48) : blend(dominant, black, 0.78);
  const panel = lightSurface ? blend(dominant, white, 0.70) : blend(dominant, black, 0.66);
  const lightText = rgb(248, 249, 252);
  const darkText = rgb(15, 17, 21);
  let text = contrastRatio(lightText, panel) > contrastRatio(darkText, panel) ? lightText : darkText;
  if (contrastRatio(text, panel) < 4.5) text = luminance(panel) > 0.18 ? rgb(0, 0, 0) : rgb(255, 255, 255);
  const accent = readableAccent(dominant, panel, lightSurface);
  const accent2 = readableAccent(shiftedAccent(accent, lightSurface), panel, lightSurface);
  const iconSurface = lightSurface
    ? blend(dominant, white, 0.68)
    : blend(dominant, black, 0.62);
  const iconForegroundSeed = lightSurface
    ? blend(dominant, black, 0.72)
    : blend(dominant, white, 0.78);
  const iconForeground = readableAccent(iconForegroundSeed, iconSurface, lightSurface);
  const iconBorder = lightSurface
    ? blend(dominant, black, 0.34)
    : blend(dominant, white, 0.34);

  return {
    dominant,
    accent,
    accent2,
    background,
    panel,
    surface2: lightSurface ? blend(panel, black, 0.06) : blend(panel, white, 0.06),
    surface3: lightSurface ? blend(panel, black, 0.12) : blend(panel, white, 0.12),
    surface4: lightSurface ? blend(panel, black, 0.19) : blend(panel, white, 0.19),
    text,
    // Keep secondary labels at a WCAG-friendly distance from the panel. The
    // old 38/58% blends looked like disabled text once the panel was translucent
    // over a bright, blurred patch of artwork.
    muted: blend(text, panel, 0.22),
    subtle: blend(text, panel, 0.35),
    iconSurface,
    iconForeground,
    iconBorder,
  };
}

function hex(color) {
  return `#${[color.r, color.g, color.b].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

export function cssVarsForPalette(palette) {
  if (!palette) return {};
  return {
    "--bg-0": hex(palette.background),
    "--bg-1": hex(palette.panel),
    "--panel-rgb": `${palette.panel.r} ${palette.panel.g} ${palette.panel.b}`,
    "--bg-2": hex(palette.surface2),
    "--bg-3": hex(palette.surface3),
    "--bg-4": hex(palette.surface4),
    "--tx-1": hex(palette.text),
    "--tx-2": hex(palette.muted),
    "--tx-3": hex(palette.subtle),
    "--accent": hex(palette.accent),
    "--accent-2": hex(palette.accent2),
    "--icon-surface": hex(palette.iconSurface),
    "--icon-fg": hex(palette.iconForeground),
    "--icon-border": hex(palette.iconBorder),
  };
}

export function artworkBackgroundStyle(imageSrc) {
  return {
    image: imageSrc ? `url(${JSON.stringify(imageSrc)})` : "none",
  };
}

export function artworkBlurPx(value) {
  const numeric = Number(value);
  return Math.max(0, Math.min(Number.isFinite(numeric) ? numeric : 6, 6));
}

// Extra crop for the wallpaper layer. `background-size: cover` still does the
// aspect-ratio work; this scale only hides edge seams and adapts to the window
// and artwork shapes without ever stretching pixels.
export function artworkZoomForViewport(imageWidth, imageHeight, viewportWidth, viewportHeight, padCrop = 1) {
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  const vw = Number(viewportWidth);
  const vh = Number(viewportHeight);
  const pad = Math.max(1, Number.isFinite(Number(padCrop)) ? Number(padCrop) : 1);
  if (![iw, ih, vw, vh].every(value => Number.isFinite(value) && value > 0)) return 1.24 * pad;
  const imageRatio = iw / ih;
  const viewportRatio = vw / vh;
  const cropMismatch = Math.max(imageRatio / viewportRatio, viewportRatio / imageRatio);
  const areaFactor = Math.sqrt((vw * vh) / (1100 * 720));
  // `cover` performs the aspect-ratio crop; this second scale makes the cover
  // fill the full-bleed layer when a source contains letterbox-like margins.
  // When the source has letterbox or pillarbox bars (pad > 1), we scale the
  // zoom by pad so the inner artwork completely fills the background.
  const baseZoom = 1.24
    + Math.max(0, cropMismatch - 1) * 0.14
    + Math.max(0, areaFactor - 1) * 0.04;
  const maxCap = pad > 1.05 ? 2.5 : 1.48;
  return Math.max(1.24 * pad, Math.min(maxCap, baseZoom * pad));
}

export function artworkDimensionsAreUsable(width, height) {
  return Number.isFinite(width) && Number.isFinite(height)
    && Math.max(width, height) >= 320;
}

export function artworkSourceCandidates(source) {
  const value = String(source || "");
  const match = value.match(/i\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\//i);
  if (!match) return value ? [value] : [];
  const root = `https://i.ytimg.com/vi/${match[1]}`;
  const candidates = [
    `${root}/maxresdefault.jpg`,
    `${root}/hq720.jpg`,
    `${root}/hqdefault.jpg`,
    `${root}/mqdefault.jpg`,
  ];
  if (!candidates.includes(value)) candidates.push(value);
  return candidates;
}

export async function resolveArtworkSource(source, load, accept = () => true) {
  let lastError;
  for (const candidate of artworkSourceCandidates(source)) {
    try {
      const value = await load(candidate);
      if (!(await accept(value, candidate))) throw new Error("artwork candidate rejected");
      return value;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("artwork source unavailable");
}

export function trimArtworkPaletteCache(cache, budget) {
  let total = [...cache.values()].reduce(
    (sum, value) => sum + String(value?.imageSrc || "").length,
    0,
  );
  while (cache.size > 1 && total > budget) {
    const key = cache.keys().next().value;
    const value = cache.get(key);
    total -= String(value?.imageSrc || "").length;
    cache.delete(key);
  }
  return cache;
}

export function createGenerationGuard() {
  let generation = 0;
  return {
    next() { return ++generation; },
    isCurrent(token) { return token === generation; },
  };
}

export function createSharedArtworkPreparation(load) {
  const pending = new Map();
  return source => {
    if (pending.has(source)) return pending.get(source);
    const task = Promise.resolve(load(source))
      .finally(() => pending.delete(source));
    pending.set(source, task);
    return task;
  };
}

export function createArtworkThemeState({ analyze, apply, restore, retain = () => {} }) {
  const guard = createGenerationGuard();
  return {
    cancel() { guard.next(); },
    async use(src) {
      const token = guard.next();
      if (!src) {
        await restore();
        return null;
      }
      try {
        const palette = await analyze(src);
        if (!guard.isCurrent(token)) return null;
        if (!palette) {
          await retain(null);
          return null;
        }
        apply(src, palette);
        return palette;
      } catch (error) {
        if (!guard.isCurrent(token)) return null;
        await retain(error);
        throw error;
      }
    },
  };
}
