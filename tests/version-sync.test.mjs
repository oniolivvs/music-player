import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const VERSION = "0.22.154";
const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("native and OTA release markers stay synchronized", async () => {
  const [ota, main, css, cargo, lock, tauri, pkg, pkgLock] = await Promise.all([
    read("../ota.json"),
    read("../src/main.js"),
    read("../src/style.css"),
    read("../src-tauri/Cargo.toml"),
    read("../src-tauri/Cargo.lock"),
    read("../src-tauri/tauri.conf.json"),
    read("../package.json"),
    read("../package-lock.json"),
  ]);

  assert.equal(JSON.parse(ota).version, VERSION);
  assert.ok(JSON.parse(ota).modules.includes("music-list.mjs"));
  assert.match(main, new RegExp(`const SRC_VERSION = "${VERSION.replaceAll(".", "\\.")}";`));
  assert.match(css, new RegExp(`^/\\* MP_CSS ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(cargo, new RegExp(`^version = "${VERSION.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(lock, new RegExp(`name = "music-player"\\r?\\nversion = "${VERSION.replaceAll(".", "\\.")}"`));
  assert.equal(JSON.parse(tauri).version, VERSION);
  assert.equal(JSON.parse(pkg).version, VERSION);
  assert.equal(JSON.parse(pkgLock).version, VERSION);
  assert.equal(JSON.parse(pkgLock).packages[""].version, VERSION);
});

test("OTA manifest contains the complete local module graph", async () => {
  const ota = JSON.parse(await read("../ota.json"));
  const pending = [...ota.modules];
  const visited = new Set();
  while (pending.length) {
    const name = pending.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const source = await read(`../src/${name}`);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])\.\/([^"']+)\1/g)) {
      assert.ok(ota.modules.includes(match[2]), `${name} imports ${match[2]}, but ota.json omits it`);
      pending.push(match[2]);
    }
  }
  assert.ok(visited.has(ota.entry));
});
