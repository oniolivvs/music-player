import test from "node:test";
import assert from "node:assert/strict";
import { pickAlternativeSource, scoreAlternativeSource } from "../src/alternative-source.mjs";

const original = { path: "yt:old", title: "My Song", artist: "The Artist", duration_secs: 240 };

test("alternative matching accepts only close public candidates", () => {
  const picked = pickAlternativeSource(original, [
    { path: "yt:live", title: "My Song live", artist: "The Artist", duration_secs: 240 },
    { path: "yt:long", title: "My Song official audio", artist: "The Artist", duration_secs: 248 },
    { path: "yt:good", title: "My Song (Official Audio)", artist: "The Artist", duration_secs: 241 },
  ]);
  assert.equal(picked.candidate.path, "yt:good");
  assert.ok(picked.score >= 90);
});

test("alternative matching rejects covers and missing duration", () => {
  assert.equal(scoreAlternativeSource(original, { title: "My Song cover", artist: "The Artist", duration_secs: 240 }), -Infinity);
  assert.equal(scoreAlternativeSource(original, { title: "My Song", artist: "The Artist", duration_secs: 0 }), -Infinity);
});

test("non-Latin titles can match their public upload", () => {
  const jp = { path: "yt:3iUgKH8c7p4", title: "いますぐ輪廻 ⧸ 初音ミク", artist: "なきそ", duration_secs: 172 };
  const picked = pickAlternativeSource(jp, [
    { path: "yt:other", title: "いますぐ輪廻 / なきそ feat. 初音ミク", artist: "なきそ - Topic", duration_secs: 173 },
    { path: "yt:cover", title: "いますぐ輪廻 歌ってみた cover", artist: "someone", duration_secs: 172 },
  ]);
  assert.equal(picked?.candidate.path, "yt:other");
  assert.equal(scoreAlternativeSource(jp, { title: "ロキ", artist: "なきそ", duration_secs: 172 }), -Infinity);
});

test("a live original may be replaced by the same live recording", () => {
  const live = { path: "yt:a", title: "My Song (Live)", artist: "The Artist", duration_secs: 300 };
  assert.ok(scoreAlternativeSource(live, { title: "My Song live", artist: "The Artist", duration_secs: 300 }) >= 90);
  assert.equal(scoreAlternativeSource(live, { title: "My Song live remix", artist: "The Artist", duration_secs: 300 }), -Infinity);
});

test("covers and spatial-audio re-uploads found on real searches are refused", () => {
  const song = { path: "yt:a", title: "言わないけどね。", artist: "大原ゆい子", duration_secs: 273 };
  assert.equal(scoreAlternativeSource(song, { title: "言わないけどね。 - 大原ゆい子 // covered by 白河しらせ", artist: "白河しらせ", duration_secs: 273 }), -Infinity);
  const vaundy = { path: "yt:b", title: "花占い", artist: "Vaundy", duration_secs: 207 };
  assert.equal(scoreAlternativeSource(vaundy, { title: "【 10D 立体音響 】 Vaundy - 花占い｜イヤホン・ヘッドホン推奨", artist: "x", duration_secs: 207 }), -Infinity);
  assert.ok(scoreAlternativeSource(vaundy, { title: "【歌詞付き】花占い - Vaundy", artist: "y", duration_secs: 206 }) >= 90);
});
