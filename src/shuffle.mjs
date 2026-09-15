// Pure queue helpers keep shuffle deterministic under test and make the
// playback controller responsible only for state transitions.
export function uniqueQueuePaths(paths = []) {
  const seen = new Set();
  return paths.filter(path => {
    const key = String(path ?? "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function shuffleSignature(paths = []) {
  return JSON.stringify(paths.map(path => String(path ?? "")));
}

export function buildShuffleOrder(length, startIdx = -1, random = Math.random) {
  const n = Math.max(0, Math.floor(Number(length) || 0));
  const order = Array.from({ length: n }, (_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const sample = Number(random());
    const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
    const j = Math.floor(bounded * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (Number.isInteger(startIdx) && startIdx >= 0 && startIdx < order.length) {
    const position = order.indexOf(startIdx);
    if (position > 0) { order.splice(position, 1); order.unshift(startIdx); }
  }
  return order;
}
