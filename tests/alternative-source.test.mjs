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
