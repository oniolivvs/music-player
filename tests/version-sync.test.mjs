import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const VERSION = "0.22.123";
const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("native and OTA release markers stay synchronized", async () => {
  const [ota, main, css, cargo, lock, tauri] = await Promise.all([
    read("../ota.json"),
    read("../src/main.js"),
    read("../src/style.css"),
    read("../src-tauri/Cargo.toml"),
    read("../src-tauri/Cargo.lock"),
    read("../src-tauri/tauri.conf.json"),
  ]);

  assert.equal(JSON.parse(ota).version, VERSION);
  assert.match(main, new RegExp(`const SRC_VERSION = "${VERSION.replaceAll(".", "\\.")}";`));
  assert.match(css, new RegExp(`^/\\* MP_CSS ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(cargo, new RegExp(`^version = "${VERSION.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(lock, new RegExp(`name = "music-player"\\r?\\nversion = "${VERSION.replaceAll(".", "\\.")}"`));
  assert.equal(JSON.parse(tauri).version, VERSION);
});
