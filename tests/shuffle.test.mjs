import test from "node:test";
import assert from "node:assert/strict";
import { buildShuffleOrder, shuffleSignature, uniqueQueuePaths } from "../src/shuffle.mjs";

test("shuffle creates a complete permutation and keeps the chosen track first", () => {
  const order = buildShuffleOrder(8, 5, () => 0.37);
  assert.equal(order[0], 5);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("shuffle tolerates invalid random values without duplicate indexes", () => {
  const values = [Number.NaN, -1, 1, Infinity];
  let cursor = 0;
  const order = buildShuffleOrder(6, -1, () => values[cursor++ % values.length]);
  assert.equal(new Set(order).size, 6);
  assert.equal(order.length, 6);
});

test("queue construction removes duplicate physical paths while preserving order", () => {
  assert.deepEqual(uniqueQueuePaths(["a.mp3", "b.mp3", "a.mp3", "", "c.mp3", null]), ["a.mp3", "b.mp3", "c.mp3"]);
});

test("shuffle signature changes when queue order or contents changes", () => {
  assert.notEqual(shuffleSignature(["a", "b"]), shuffleSignature(["b", "a"]));
  assert.notEqual(shuffleSignature(["a", "b"]), shuffleSignature(["a", "c"]));
  assert.equal(shuffleSignature(["a", "b"]), shuffleSignature(["a", "b"]));
});
