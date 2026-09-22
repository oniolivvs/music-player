import test from "node:test";
import assert from "node:assert/strict";
import { activeLyricIndex, parseTimedLyrics, plainLyricsLines } from "../src/lyrics.mjs";

test("LRC timestamps parse and select the active lyric", () => {
  const lines = parseTimedLyrics("[00:01.20] First\n[00:03.50] Second", "lrc");
  assert.deepEqual(lines.map(line => line.text), ["First", "Second"]);
  assert.equal(activeLyricIndex(lines, 2), 0);
  assert.equal(activeLyricIndex(lines, 3.6), 1);
});

test("WebVTT captions and plain lyrics remain readable", () => {
  const lines = parseTimedLyrics("WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHello <b>world</b>", "vtt");
  assert.deepEqual(lines, [{ time: 2, text: "Hello world" }]);
  assert.deepEqual(plainLyricsLines(" one \n\n two "), ["one", "two"]);
});
