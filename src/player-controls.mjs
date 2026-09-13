export function clampSeekPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

export function clampVolumePercent(value) {
  return clampSeekPercent(value);
}

// Human hearing is logarithmic. A cubic taper gives the 0–100 control useful
// travel at normal listening levels instead of packing them into the first 2%.
export function volumeGainFromPercent(value) {
  const normalized = clampVolumePercent(value) / 100;
  return normalized ** 3;
}

export function seekSecondsForPercent(percent, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return (clampSeekPercent(percent) / 100) * total;
}

export function seekPercentForSeconds(seconds, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return clampSeekPercent((Number(seconds) || 0) / total * 100);
}
