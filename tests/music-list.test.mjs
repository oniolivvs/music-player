import test from "node:test";
import assert from "node:assert/strict";
import { parseMusicList } from "../src/music-list.mjs";

test("HDD music.json entries become unique YouTube tracks", () => {
  const result = parseMusicList(JSON.stringify([
    { name: "Track one", youtube_id: "l2x087JvRsU" },
    { name: "Duplicate", youtube_id: "l2x087JvRsU" },
    { name: "Broken", youtube_id: "bad" },
  ]));
  assert.deepEqual(result.tracks.map(track => [track.path, track.title]), [["yt:l2x087JvRsU", "Track one"]]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 1);
});

test("music list accepts wrapped arrays and YouTube URLs", () => {
  const result = parseMusicList({ songs: [
    { title: "Watch", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { title: "Short", url: "https://youtu.be/9bZkp7q19f0" },
  ] });
  assert.deepEqual(result.tracks.map(track => track.path), ["yt:dQw4w9WgXcQ", "yt:9bZkp7q19f0"]);
});

test("music list rejects unrelated JSON", () => {
  assert.throws(() => parseMusicList('{"hello":"world"}'), /Expected a JSON array/);
  assert.throws(() => parseMusicList('[{"youtube_id":"bad"}]'), /No valid YouTube IDs/);
});
