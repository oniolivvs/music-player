import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_KIND, backupSummary, createBackup, parseBackup } from "../src/data-transfer.mjs";

test("backup round-trips portable app data", () => {
  const source = createBackup({
    settings: { accent: "blue" },
    playlists: [{ id: "p1", name: "Mix", paths: ["yt:a"] }],
    library: { folders: ["D:/Music"], tracks: [{ path: "D:/Music/a.mp3" }] },
    follows: [{ id: "f1" }], plays: { "yt:a": { n: 2 } }, history: [{ path: "yt:a" }],
    online: { "yt:a": { title: "A" } }, blocked: ["b"], suppressed: ["s"], declined: ["d"],
  }, "2026-09-13T00:00:00.000Z");
  const restored = parseBackup(JSON.stringify(source));
  assert.equal(restored.kind, BACKUP_KIND);
  assert.deepEqual(restored.data, source.data);
  assert.deepEqual(backupSummary(restored), { playlists: 1, tracks: 1, follows: 1, plays: 1 });
});

test("backup parser rejects unrelated and future formats", () => {
  assert.throws(() => parseBackup("not json"), /valid JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ kind: "other", version: 1, data: {} })), /not a Music Player backup/);
  assert.throws(() => parseBackup(JSON.stringify({ kind: BACKUP_KIND, version: 99, data: {} })), /Unsupported backup version/);
});
