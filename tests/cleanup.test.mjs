import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as cleanupRenderer from "../src/cleanup.mjs";
import {
  chooseDuplicatePlan,
  rewritePaths,
  dedupePlaylistPaths,
  collectBlockedPaths,
  clearSuccessfulBlockKeys,
  duplicateConfirmationResults,
  removeQueuePaths,
  rewriteQueuePaths,
  queueSignature,
  createGenerationGuard,
  persistLatestGeneration,
  persistInOrder,
  runPlaybackTransition,
  buildCleanupSummary,
} from "../src/cleanup.mjs";

test("cleanup playlist selector has an accessible name", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const selector = source.match(/<select id="setCleanupPlaylist"[^>]*>/)?.[0];
  assert.ok(selector);
  assert.match(selector, /\baria-label="Playlist to clean"/);
});

test("cleanup layout keeps all delete actions together and playlist scope separate", () => {
  assert.equal(typeof cleanupRenderer.buildCleanupActionLayout, "function", "cleanup layout renderer must exist");
  const markup = cleanupRenderer.buildCleanupActionLayout({
    deleteBlocked: '<button data-marker="blocked">Blocked</button>',
    deleteFiles: '<button data-marker="files">Files</button>',
    deletePlaylistEntries: '<button data-marker="playlist-delete">Playlist duplicates</button>',
    playlistSelector: '<select id="setCleanupPlaylist"><option>All</option></select>',
  });
  const deleteGroup = markup.match(/<div class="cleanup-delete-actions">([\s\S]*?)<\/div>/)?.[1] || "";
  const playlistScope = markup.match(/<div class="cleanup-playlist-scope">([\s\S]*?)<\/div>/)?.[1] || "";

  assert.ok(deleteGroup.indexOf('data-marker="blocked"') >= 0);
  assert.ok(deleteGroup.indexOf('data-marker="files"') > deleteGroup.indexOf('data-marker="blocked"'));
  assert.ok(deleteGroup.indexOf('data-marker="playlist-delete"') > deleteGroup.indexOf('data-marker="files"'));
  assert.doesNotMatch(deleteGroup, /setCleanupPlaylist/);
  assert.match(playlistScope, /<label for="setCleanupPlaylist">Playlist scope<\/label>/);
  assert.match(playlistScope, /id="setCleanupPlaylist"/);
});

test("startup registers the resolved writable download root", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(source, /await invoke\("yt_download_root", \{ dir: String\(S\(\)\.downloadDir \|\| ""\) \}\)/);
  assert.match(source, /if \(downloadRoot\) roots\.push\(downloadRoot\)/);
  assert.match(source, /invoke\("register_roots", \{ paths: roots \}\)/);
});

test("cleanup summary counts successful entries, local files, failures and bytes", () => {
  const items = [
    { path: "D:/Music/a.mp3", local: true, bytes: 80, failed: false },
    { path: "yt:streamed", local: false, bytes: 0, failed: false },
    { path: "D:/Music/locked.mp3", local: true, bytes: 20, failed: true },
    { path: "yt:unavailable", local: false, bytes: 0, failed: true },
  ];

  assert.deepEqual(buildCleanupSummary(items), {
    entries: 2,
    files: 1,
    failed: 2,
    bytes: 80,
  });
});

test("duplicate keeper is the most referenced path", () => {
  const groups = [{ paths: ["D:/Music/a.mp3", "D:/Copy/a.mp3"], bytes: 100 }];
  const playlists = [
    { paths: ["D:/Copy/a.mp3"] },
    { paths: ["D:/Copy/a.mp3", "D:/Music/a.mp3"] },
  ];
  assert.deepEqual(chooseDuplicatePlan(groups, playlists), [{
    keep: "D:/Copy/a.mp3",
    remove: ["D:/Music/a.mp3"],
  }]);
});

test("duplicate keeper breaks equal references by shortest path", () => {
  const groups = [{ paths: ["D:/Music/long-name.mp3", "D:/a.mp3"] }];
  const playlists = [
    { paths: ["D:/Music/long-name.mp3"] },
    { paths: ["D:/a.mp3"] },
  ];
  assert.deepEqual(chooseDuplicatePlan(groups, playlists), [{
    keep: "D:/a.mp3",
    remove: ["D:/Music/long-name.mp3"],
  }]);
});

test("duplicate keeper breaks equal references and length lexically", () => {
  const groups = [{ paths: ["D:/z.mp3", "D:/a.mp3"] }];
  const playlists = [
    { paths: ["D:/z.mp3"] },
    { paths: ["D:/a.mp3"] },
  ];
  assert.deepEqual(chooseDuplicatePlan(groups, playlists), [{
    keep: "D:/a.mp3",
    remove: ["D:/z.mp3"],
  }]);
});

test("duplicate keeper uses code-point ordering across locale-sensitive paths", () => {
  const groups = [{ paths: ["D:/é.mp3", "D:/z.mp3", "D:/Z.mp3"] }];
  const playlists = [{ paths: ["D:/é.mp3", "D:/z.mp3", "D:/Z.mp3"] }];

  assert.deepEqual(chooseDuplicatePlan(groups, playlists), [{
    keep: "D:/Z.mp3",
    remove: ["D:/z.mp3", "D:/é.mp3"],
  }]);
});

test("only native duplicate-confirmation successes rewrite references", () => {
  const plan = [{ keep: "keep.mp3", remove: ["deleted-copy.mp3", "changed-copy.mp3"] }];
  const result = duplicateConfirmationResults(plan, [
    { path: "deleted-copy.mp3", deleted: true },
    { path: "changed-copy.mp3", deleted: false, error: "content changed" },
  ]);
  assert.deepEqual(result.replacements, new Map([["deleted-copy.mp3", "keep.mp3"]]));
  assert.deepEqual(result.failures, new Map([["changed-copy.mp3", "content changed"]]));
});

test("rewrite replaces removed copies and keeps first order", () => {
  const replacements = new Map([["copy.mp3", "keep.mp3"]]);
  assert.deepEqual(rewritePaths(["copy.mp3", "other.mp3", "keep.mp3"], replacements, new Set()),
    ["keep.mp3", "other.mp3"]);
});

test("rewrite omits paths removed after replacement", () => {
  const replacements = new Map([["copy.mp3", "keep.mp3"]]);
  assert.deepEqual(rewritePaths(["copy.mp3", "remove.mp3"], replacements, new Set(["remove.mp3"])),
    ["keep.mp3"]);
});

test("playlist dedupe keeps the first musical identity", () => {
  const identities = new Map([["yt:id", "song:id"], ["local[id].mp3", "song:id"]]);
  assert.deepEqual(dedupePlaylistPaths(["yt:id", "other", "local[id].mp3"], identities), {
    paths: ["yt:id", "other"], removed: 1,
  });
});

test("blocked collection is unique and only includes blocked keys", () => {
  const blockKeyByPath = new Map([
    ["D:/Music/a.mp3", "video:a"],
    ["D:/Music/b.mp3", "video:b"],
    ["D:/Music/c.mp3", "video:c"],
  ]);
  assert.deepEqual(collectBlockedPaths(
    ["D:/Music/a.mp3", "D:/Music/b.mp3", "D:/Music/a.mp3", "D:/Music/c.mp3"],
    new Set(["video:a", "video:c"]),
    blockKeyByPath,
  ), ["D:/Music/a.mp3", "D:/Music/c.mp3"]);
});

test("cleanup clears only successful block keys and preserves a key shared with a failure", () => {
  const keyByPath = new Map([
    ["D:/Music/ok.mp3", "video:ok"],
    ["D:/Music/failed-copy.mp3", "video:shared"],
    ["D:/Music/removed-copy.mp3", "video:shared"],
    ["D:/Music/outside.mp3", "video:outside"],
  ]);

  assert.deepEqual(
    clearSuccessfulBlockKeys(
      new Set(["video:ok", "video:shared", "video:outside"]),
      new Set(["D:/Music/ok.mp3", "D:/Music/removed-copy.mp3"]),
      new Set(["D:/Music/failed-copy.mp3"]),
      keyByPath,
    ),
    new Set(["video:shared", "video:outside"]),
  );
});

test("queue removal shifts the active index when an earlier path is removed", () => {
  assert.deepEqual(removeQueuePaths(
    ["before.mp3", "active.mp3", "after.mp3"],
    1,
    new Set(["before.mp3"]),
  ), {
    queue: ["active.mp3", "after.mp3"], currentIndex: 0, activeRemoved: false,
  });
});

test("queue removal selects the next surviving slot when active is removed", () => {
  assert.deepEqual(removeQueuePaths(
    ["before.mp3", "active.mp3", "after.mp3", "last.mp3"],
    1,
    new Set(["active.mp3", "after.mp3"]),
  ), {
    queue: ["before.mp3", "last.mp3"], currentIndex: 1, activeRemoved: true,
  });
});

test("queue removal clamps the active replacement to the last slot", () => {
  assert.deepEqual(removeQueuePaths(
    ["before.mp3", "active.mp3", "last.mp3"],
    1,
    new Set(["active.mp3", "last.mp3"]),
  ), {
    queue: ["before.mp3"], currentIndex: 0, activeRemoved: true,
  });
});

test("queue removal uses -1 for an empty queue", () => {
  assert.deepEqual(removeQueuePaths(["active.mp3"], 0, new Set(["active.mp3"])), {
    queue: [], currentIndex: -1, activeRemoved: true,
  });
});

test("duplicate queue rewrite follows the active occurrence instead of indexOf", () => {
  const rewritten = rewriteQueuePaths(
    ["keep.mp3", "prior.mp3", "active-copy.mp3"],
    2,
    new Map([["active-copy.mp3", "keep.mp3"]]),
    new Set(),
  );

  assert.deepEqual(rewritten, {
    queue: ["keep.mp3", "prior.mp3"],
    currentIndex: 0,
    activeChanged: true,
  });
});

test("queue signature changes when only an interior occurrence changes", () => {
  assert.notEqual(
    queueSignature(["first.mp3", "old-middle.mp3", "last.mp3"]),
    queueSignature(["first.mp3", "new-middle.mp3", "last.mp3"]),
  );
});

test("cleanup generation guard rejects a stale playback continuation", () => {
  const guard = createGenerationGuard();
  const cleanupGeneration = guard.current();
  guard.advance(); // a user playback action wins while cleanup awaits disk I/O
  let staleCleanupRestartedPlayback = false;
  if (guard.isCurrent(cleanupGeneration)) staleCleanupRestartedPlayback = true;
  assert.equal(staleCleanupRestartedPlayback, false);
});

test("automatic playback transitions invalidate a pending cleanup before applying state", () => {
  const guard = createGenerationGuard();
  const cleanupGeneration = guard.current();
  const playback = { index: 0 };

  runPlaybackTransition(guard, () => { playback.index = 1; });

  assert.equal(playback.index, 1);
  assert.equal(guard.isCurrent(cleanupGeneration), false);
});

test("cleanup playback persistence retries with the newest stable generation", async () => {
  const guard = createGenerationGuard();
  const cleanupGeneration = guard.current();
  let playback = { queue: ["cleaned.mp3"], index: 0 };
  const persisted = [];

  const saved = await persistLatestGeneration(
    guard,
    cleanupGeneration,
    () => structuredClone(playback),
    async snapshot => {
      persisted.push(snapshot);
      if (persisted.length === 1) {
        playback = { queue: ["user-choice.mp3"], index: 0 };
        runPlaybackTransition(guard, () => {});
      }
    },
  );

  assert.deepEqual(persisted, [
    { queue: ["cleaned.mp3"], index: 0 },
    { queue: ["user-choice.mp3"], index: 0 },
  ]);
  assert.deepEqual(saved, { queue: ["user-choice.mp3"], index: 0 });
});

test("cleanup playback persistence rejects when playback never becomes stable", async () => {
  const guard = createGenerationGuard();
  let writes = 0;

  await assert.rejects(
    persistLatestGeneration(
      guard,
      guard.current(),
      () => ({ index: writes }),
      async () => { writes++; guard.advance(); },
      2,
    ),
    /playback changed during cleanup/i,
  );
  assert.equal(writes, 2);
});

test("cleanup persistence is ordered and propagates the first write failure", async () => {
  const calls = [];
  await assert.rejects(
    persistInOrder([
      async () => { calls.push("library"); },
      async () => { calls.push("playlists"); throw new Error("disk full"); },
      async () => { calls.push("blocked"); },
    ]),
    /disk full/,
  );
  assert.deepEqual(calls, ["library", "playlists"]);
});
