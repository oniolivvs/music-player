import test from "node:test";
import assert from "node:assert/strict";
import { disableOrphanedFollows } from "../src/follow-reconciliation.mjs";

test("orphaned enabled follows are disabled without mutating inputs", () => {
  const follows = [
    { id: "orphan", playlistId: "missing", enabled: true },
    { id: "valid", playlistId: "kept", enabled: true },
  ];
  const result = disableOrphanedFollows(follows, [{ id: "kept" }]);

  assert.equal(result.changed, true);
  assert.equal(result.follows[0].enabled, false);
  assert.equal(result.follows[1], follows[1]);
  assert.equal(follows[0].enabled, true);
});

test("valid and already-disabled follows need no repair", () => {
  const follows = [
    { id: "valid", playlistId: "kept", enabled: true },
    { id: "disabled", playlistId: "missing", enabled: false },
  ];
  const result = disableOrphanedFollows(follows, [{ id: "kept" }]);

  assert.equal(result.changed, false);
  assert.equal(result.follows, follows);
});
