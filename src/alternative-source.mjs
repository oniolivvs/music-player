// Other recordings of a song. Latin words need \b; CJK terms cannot use it (\b
// only sees ASCII word characters). Each match maps to one canonical tag.
const VARIANTS = /\b(live|cover(?:ed|s)?|remix|reaction|karaoke|instrumental|sped\s*up|slowed|reverb|nightcore|loop|extended|edit|shorts?|teaser|trailer|mashup|fanmade|acoustic|bass\s*boosted|\d{1,2}d(?:\s*audio)?)\b|(歌ってみた|弾いてみた|叩いてみた|演奏してみた|カバー|立体音響|ライブ|リミックス|耐久|オルゴール)/gi;
const VARIANT_TAG = {
  covered: "cover", covers: "cover", "歌ってみた": "cover", "弾いてみた": "cover", "叩いてみた": "cover", "演奏してみた": "cover", "カバー": "cover",
  "立体音響": "spatial", "ライブ": "live", "リミックス": "remix", "耐久": "loop", "オルゴール": "instrumental", shorts: "short",
};
function variantTag(raw) {
  const word = raw.toLowerCase().replace(/\s+/g, "");
  if (/^\d{1,2}d(audio)?$/.test(word)) return "spatial";
  return VARIANT_TAG[word] || word;
}
const NOISE = /\b(official|audio|video|lyrics?|mv|music)\b/gi;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Unicode-aware: the old [^a-z0-9] filter erased Japanese, Korean or Cyrillic
// titles entirely, so no alternative could ever match them.
export function normalizeTrackText(value = "") {
  return String(value).normalize("NFKD").replace(/\p{M}/gu, "").replace(NOISE, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

// CJK titles carry no spaces between words: compare them by character pairs.
function tokens(value) {
  const out = new Set();
  for (const word of normalizeTrackText(value).split(" ").filter(Boolean)) {
    if (!CJK.test(word) || word.length < 3) { out.add(word); continue; }
    const chars = [...word];
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

function overlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return common / left.size;
}

function variantTags(text) {
  return new Set([...String(text || "").matchAll(VARIANTS)].map(match => variantTag(match[1] || match[2])));
}

export function scoreAlternativeSource(original, candidate) {
  const od = Number(original?.duration_secs) || 0;
  const cd = Number(candidate?.duration_secs) || 0;
  const label = `${candidate?.title || ""} ${candidate?.artist || ""}`;
  // A variant tag the original does not carry (a cover for a studio track) is
  // refused; the same tag on both sides (a live track for a live track) is fine.
  const own = variantTags(`${original?.title || ""} ${original?.artist || ""}`);
  if (!od || !cd || Math.abs(od - cd) > 2 || [...variantTags(label)].some(tag => !own.has(tag))) return -Infinity;
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
