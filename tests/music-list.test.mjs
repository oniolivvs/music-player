import test from "node:test";
import assert from "node:assert/strict";
import { mergeMusicListPaths, parseMusicList, youtubeThumbnailFor } from "../src/music-list.mjs";

test("HDD music.json entries become unique YouTube tracks", () => {
  const result = parseMusicList(JSON.stringify([
    { name: "Track one", youtube_id: "l2x087JvRsU" },
    { name: "Duplicate", youtube_id: "l2x087JvRsU" },
    { name: "Broken", youtube_id: "bad" },
  ]));
  assert.deepEqual(result.tracks.map(track => [track.path, track.title]), [["yt:l2x087JvRsU", "Track one"]]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.tracks[0].thumbnail, "https://i.ytimg.com/vi/l2x087JvRsU/mqdefault.jpg");
});

test("music list accepts wrapped arrays and YouTube URLs", () => {
  const result = parseMusicList({ songs: [
    { title: "Watch", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    { title: "Short", url: "https://youtu.be/9bZkp7q19f0" },
  ] });
  assert.deepEqual(result.tracks.map(track => track.path), ["yt:dQw4w9WgXcQ", "yt:9bZkp7q19f0"]);
});

test("legacy local downloads recover their YouTube cover from the filename", () => {
  assert.equal(
    youtubeThumbnailFor("C:\\Music\\Track [l2x087JvRsU].mp3"),
    "https://i.ytimg.com/vi/l2x087JvRsU/mqdefault.jpg",
  );
  assert.equal(youtubeThumbnailFor("C:\\Music\\Track.mp3"), "");
});

test("music list rejects unrelated JSON", () => {
  assert.throws(() => parseMusicList('{"hello":"world"}'), /Expected a JSON array/);
  assert.throws(() => parseMusicList('[{"youtube_id":"bad"}]'), /No valid YouTube IDs/);
});

test("music list merge preserves playlist titles absent from the JSON", () => {
  const existing = ["D:\\Music\\kept.mp3", "D:\\Music\\old [l2x087JvRsU].mp3"];
  const incoming = [
    { path: "yt:l2x087JvRsU" },
    { path: "yt:dQw4w9WgXcQ" },
  ];
  assert.deepEqual(
    mergeMusicListPaths(existing, incoming, id => id === "dQw4w9WgXcQ" ? "D:\\Music\\new [dQw4w9WgXcQ].mp3" : ""),
    ["D:\\Music\\kept.mp3", "D:\\Music\\old [l2x087JvRsU].mp3", "D:\\Music\\new [dQw4w9WgXcQ].mp3"],
  );
});
