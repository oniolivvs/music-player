export const BACKUP_KIND = "music-player-backup";
export const BACKUP_VERSION = 1;

const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function createBackup(state, createdAt = new Date().toISOString()) {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt,
    data: {
      settings: object(state.settings),
      playlists: array(state.playlists),
      library: object(state.library),
      follows: array(state.follows),
      plays: object(state.plays),
      history: array(state.history),
      online: object(state.online),
      blocked: array(state.blocked),
      suppressed: array(state.suppressed),
      declined: array(state.declined),
    },
  };
}

export function parseBackup(raw) {
  let backup;
  try { backup = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new Error("This file is not valid JSON."); }
  if (!backup || backup.kind !== BACKUP_KIND) throw new Error("This is not a Music Player backup.");
  if (backup.version !== BACKUP_VERSION) throw new Error(`Unsupported backup version: ${backup.version ?? "missing"}.`);
  if (!backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) throw new Error("The backup data is missing.");
  return createBackup(backup.data, typeof backup.createdAt === "string" ? backup.createdAt : "");
}

export function backupSummary(backup) {
  const data = backup.data;
  return {
    playlists: data.playlists.length,
    tracks: array(data.library.tracks).length,
    follows: data.follows.length,
    plays: Object.keys(data.plays).length,
  };
}
