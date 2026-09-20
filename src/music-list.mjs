const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(value) {
  const raw = String(value || "").trim();
  const direct = raw.startsWith("yt:") ? raw.slice(3) : raw;
  if (VIDEO_ID.test(direct)) return direct;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return VIDEO_ID.test(id) ? id : "";
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const id = url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/)?.[1] || "";
      return VIDEO_ID.test(id) ? id : "";
    }
  } catch {}
  return "";
}

export function parseMusicList(input) {
  let data;
  try { data = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new Error("Invalid JSON music list."); }
  const rows = Array.isArray(data) ? data : [data?.tracks, data?.songs, data?.music, data?.items].find(Array.isArray);
  if (!rows) throw new Error("Expected a JSON array of tracks.");

  const tracks = [], seen = new Set();
  let invalid = 0, duplicates = 0;
  for (const row of rows) {
    const item = row && typeof row === "object" ? row : { youtube_id: row };
    const id = youtubeId(item.youtube_id ?? item.youtubeId ?? item.video_id ?? item.videoId ?? item.id ?? item.url ?? item.path);
    if (!id) { invalid++; continue; }
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    tracks.push({
      path: `yt:${id}`,
      title: String(item.name ?? item.title ?? `YouTube Track (${id})`).trim() || `YouTube Track (${id})`,
      artist: String(item.artist ?? "YouTube").trim() || "YouTube",
      album: String(item.album ?? "YouTube").trim() || "YouTube",
      duration_secs: Math.max(0, Number(item.duration_secs ?? item.duration ?? 0) || 0),
      gain: 1,
      thumbnail: String(item.thumbnail ?? "").trim() || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    });
  }
  if (!tracks.length) throw new Error("No valid YouTube IDs found in this music list.");
  return { tracks, invalid, duplicates };
}

function pathId(path) {
  const direct = youtubeId(path);
  if (direct) return direct;
  return String(path || "").match(/\[([A-Za-z0-9_-]{11})\](?:\.[A-Za-z0-9]+)?$/)?.[1] || "";
}

export function youtubeThumbnailFor(value) {
  const id = pathId(value);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "";
}

export function mergeMusicListPaths(existingPaths, tracks, localPathFor = () => "") {
  const merged = new Map((Array.isArray(existingPaths) ? existingPaths : []).map(path => [pathId(path) || path, path]));
  for (const track of tracks || []) {
    const id = pathId(track?.path);
    if (!id) continue;
    const current = merged.get(id);
    const playlistLocal = current && !String(current).startsWith("yt:") ? current : "";
    merged.set(id, localPathFor(id) || playlistLocal || track.path);
  }
  return [...merged.values()];
}
