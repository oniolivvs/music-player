const REJECT = /\b(live|cover|remix|reaction|karaoke|instrumental|sped\s*up|slowed|nightcore|loop|extended|edit|shorts?|teaser|trailer|mashup|fanmade)\b/i;
const NOISE = /\b(official|audio|video|lyrics?|mv|music)\b/gi;

export function normalizeTrackText(value = "") {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(NOISE, " ").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

function overlap(a, b) {
  const left = new Set(normalizeTrackText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeTrackText(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return common / left.size;
}

export function scoreAlternativeSource(original, candidate) {
  const od = Number(original?.duration_secs) || 0;
  const cd = Number(candidate?.duration_secs) || 0;
  const label = `${candidate?.title || ""} ${candidate?.artist || ""}`;
  if (!od || !cd || Math.abs(od - cd) > 2 || REJECT.test(label)) return -Infinity;
  const title = overlap(original?.title, candidate?.title);
  const artist = Math.max(overlap(original?.artist, candidate?.artist), overlap(original?.artist, candidate?.title));
  if (title < 0.8 || artist < 0.5) return -Infinity;
  return Math.round(title * 60 + artist * 25 + (1 - Math.abs(od - cd) / 3) * 15);
}

export function pickAlternativeSource(original, candidates = []) {
  const originalId = String(original?.path || "").replace(/^yt:/, "");
  return candidates
    .filter(candidate => String(candidate?.path || "").replace(/^yt:/, "") !== originalId)
    .map(candidate => ({ candidate, score: scoreAlternativeSource(original, candidate) }))
    .filter(result => result.score >= 90)
    .sort((a, b) => b.score - a.score)[0] || null;
}
