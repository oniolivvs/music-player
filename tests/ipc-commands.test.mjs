import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Every command the frontend invokes must be registered in the native
// generate_handler! list: an unregistered name only fails at runtime with
// "Command … not found", long after the UI shipped over OTA.
const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

function frontendCommands() {
  const names = new Set();
  for (const file of readdirSync(new URL("src/", root))) {
    if (!/\.(m?js)$/.test(file)) continue;
    for (const match of read(`src/${file}`).matchAll(/invoke\(\s*"([a-z0-9_]+)"/g)) names.add(match[1]);
  }
  return names;
}

function nativeCommands() {
  const lib = read("src-tauri/src/lib.rs");
  const start = lib.indexOf("generate_handler![");
  const end = lib.indexOf("])", start);
  return new Set(lib.slice(start, end).split(/[,\s]+/).map(item => item.split("::").pop()).filter(name => /^[a-z0-9_]+$/.test(name)));
}

test("every frontend invoke targets a registered native command", () => {
  const native = nativeCommands();
  assert.ok(native.size > 20, "generate_handler list was not found");
  const missing = [...frontendCommands()].filter(name => !native.has(name));
  assert.deepEqual(missing, []);
});
