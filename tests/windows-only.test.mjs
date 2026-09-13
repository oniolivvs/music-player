import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("release and OTA configuration stay Windows-only", async () => {
  const [ota, tauri, capability, cargo, core, release] = await Promise.all([
    read("ota.json"),
    read("src-tauri/tauri.conf.json"),
    read("src-tauri/capabilities/desktop.json"),
    read("src-tauri/Cargo.toml"),
    read("src-tauri/src/lib.rs"),
    read(".github/workflows/release.yml"),
  ]);

  assert.deepEqual(JSON.parse(ota).platforms, ["windows"]);
  assert.deepEqual(JSON.parse(tauri).bundle.targets, ["nsis"]);
  assert.deepEqual(JSON.parse(capability).platforms, ["windows"]);
  assert.doesNotMatch(cargo, /target_os = "android"|all\(unix/);
  assert.match(core, /compile_error!\("Music Player is supported on Windows only\."\)/);
  assert.match(release, /runs-on: windows-latest/);
  assert.doesNotMatch(release, /ubuntu|AppImage|\.deb|\.rpm|install\.sh/i);
  await assert.rejects(access(new URL(".github/workflows/android.yml", root)));
  await assert.rejects(access(new URL(".github/android/debug.keystore", root)));
  await assert.rejects(access(new URL("install.sh", root)));
});
