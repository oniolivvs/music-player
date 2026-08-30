import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics } from "../src/diagnostics.mjs";

test("console errors stay visible and emit one structured event", async () => {
  const native = [];
  const original = [];
  const consoleRef = { error: (...args) => original.push(args), warn() {} };
  const diagnostics = createDiagnostics({
    nativeInvoke: async (cmd, args) => native.push({ cmd, args }),
    consoleRef,
    eventTarget: new EventTarget(),
  });

  diagnostics.start();
  consoleRef.error("[audio]", new Error("device gone"));
  await diagnostics.flush();

  assert.equal(original.length, 1);
  assert.equal(native.length, 1);
  assert.equal(native[0].cmd, "diag_write");
  assert.equal(native[0].args.component, "audio");
  assert.match(native[0].args.detail, /device gone/);
  diagnostics.stop();
});

test("a rejected log write never recurses through patched console", async () => {
  let writes = 0;
  let visible = 0;
  const consoleRef = { error: () => visible++, warn() {} };
  const diagnostics = createDiagnostics({
    nativeInvoke: async () => {
      writes++;
      throw new Error("bridge down");
    },
    consoleRef,
    eventTarget: new EventTarget(),
  });

  diagnostics.start();
  consoleRef.error("boom");
  await diagnostics.flush();

  assert.equal(writes, 1);
  assert.equal(visible, 1);
  diagnostics.stop();
});

test("stop restores console and removes global listeners", async () => {
  const original = () => {};
  const consoleRef = { error: original, warn: original };
  const target = new EventTarget();
  const native = [];
  const diagnostics = createDiagnostics({
    nativeInvoke: async (cmd, args) => native.push({ cmd, args }),
    consoleRef,
    eventTarget: target,
  });

  diagnostics.start();
  diagnostics.stop();
  target.dispatchEvent(new Event("unhandledrejection"));
  await diagnostics.flush();

  assert.equal(consoleRef.error, original);
  assert.equal(consoleRef.warn, original);
  assert.equal(native.length, 0);
});

test("browser fallback retains only the newest 200 entries", async () => {
  const diagnostics = createDiagnostics({
    consoleRef: { error() {}, warn() {} },
    eventTarget: new EventTarget(),
  });
  for (let index = 0; index < 220; index++) {
    diagnostics.record("info", "test", "line", `event-${index}`);
  }

  const entries = await diagnostics.tail(999);
  assert.equal(entries.length, 200);
  assert.equal(entries[0].detail, "event-20");
  assert.equal(entries[199].detail, "event-219");
});
