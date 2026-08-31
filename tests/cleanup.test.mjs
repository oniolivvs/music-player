import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseDuplicatePlan,
  rewritePaths,
  dedupePlaylistPaths,
  collectBlockedPaths,
  removeQueuePaths,
} from "../src/cleanup.mjs";

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
