const YOUTUBE_HOST = /(^|\.)youtube\.com$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function normalizeSingleVideoUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); }
  catch { throw new Error("Paste a valid YouTube video URL."); }
  let id = "";
  if (/^youtu\.be$/i.test(url.hostname)) id = url.pathname.split("/").filter(Boolean)[0] || "";
  else if (YOUTUBE_HOST.test(url.hostname)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
    else if (/^\/(shorts|live)\//.test(url.pathname)) id = url.pathname.split("/")[2] || "";
  }
  if (!VIDEO_ID.test(id)) throw new Error("Music import accepts one YouTube video at a time. Use Import playlist for playlists.");
  return `https://www.youtube.com/watch?v=${id}`;
}

export function singleTrackFromResult(result) {
  const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
  if (tracks.length !== 1) throw new Error("Expected exactly one video. Use Import playlist for playlists.");
  return tracks[0];
}
