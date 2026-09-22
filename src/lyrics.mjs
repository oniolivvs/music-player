function timeValue(minutes, seconds, fraction = "0") {
  return Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
}

export function parseTimedLyrics(content = "", format = "") {
  const lines = [];
  const kind = String(format).toLowerCase();
  if (kind === "lrc" || /\[\d{1,3}:\d{2}(?:[.:]\d+)?\]/.test(content)) {
    for (const raw of String(content).split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const text = raw.replace(/\[[^\]]+\]/g, "").trim();
      if (!text) continue;
      for (const stamp of stamps) lines.push({ time: timeValue(stamp[1], stamp[2], stamp[3]), text });
    }
  } else if (kind === "vtt" || /^WEBVTT/m.test(content)) {
    const rows = String(content).split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const match = rows[i].match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->/);
      if (!match) continue;
      const text = rows.slice(i + 1).find(row => row.trim() && !row.includes("-->"))?.replace(/<[^>]+>/g, "").trim();
      if (text) lines.push({ time: Number(match[1] || 0) * 3600 + timeValue(match[2], match[3], match[4]), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function activeLyricIndex(lines, seconds) {
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time > seconds + 0.08) break;
    found = i;
  }
  return found;
}

export function plainLyricsLines(content = "") {
  return String(content).split(/\r?\n/).map(text => text.trim()).filter(Boolean);
}
