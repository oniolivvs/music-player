import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSingleVideoUrl, singleTrackFromResult } from "../src/import-policy.mjs";

test("music import canonicalizes one video and strips playlist context", () => {
  assert.equal(normalizeSingleVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeSingleVideoUrl("https://youtu.be/dQw4w9WgXcQ?t=4"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeSingleVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("music import rejects playlists and multi-track responses", () => {
  assert.throws(() => normalizeSingleVideoUrl("https://www.youtube.com/playlist?list=PL123"), /one YouTube video/);
  assert.throws(() => singleTrackFromResult({ tracks: [{ id: "a" }, { id: "b" }] }), /exactly one video/);
  assert.deepEqual(singleTrackFromResult({ tracks: [{ id: "a" }] }), { id: "a" });
});
