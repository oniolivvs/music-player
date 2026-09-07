export function disableOrphanedFollows(follows, playlists) {
  const source = Array.isArray(follows) ? follows : [];
  const playlistIds = new Set((Array.isArray(playlists) ? playlists : []).map(playlist => playlist?.id));
  let changed = false;
  const repaired = source.map(follow => {
    if (follow?.enabled === false || playlistIds.has(follow?.playlistId)) return follow;
    changed = true;
    return { ...follow, enabled: false };
  });
  return { follows: changed ? repaired : source, changed };
}
