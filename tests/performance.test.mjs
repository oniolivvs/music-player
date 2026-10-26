import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

// A synchronous Tauri command runs on the window's main thread: fs_exists on a
// sleeping hard disk froze the whole window ("Not responding") at startup.
test("file existence checks never run on the window thread", async () => {
  const lib = await read("../src-tauri/src/lib.rs");
  assert.match(lib, /#\[tauri::command\]\s*\nasync fn fs_exists\(path: String\) -> i32 \{\s*\n\s*tauri::async_runtime::spawn_blocking/);
});

// Minimized, WebView2 kept compositing every frame (more GPU than in the
// foreground): it must be hidden while the window is minimized.
test("the WebView stops rendering while the window is minimized", async () => {
  const lib = await read("../src-tauri/src/lib.rs");
  assert.match(lib, /pause_rendering_while_minimized\(app\);\s*\n\s*Ok\(\(\)\)/);
  assert.match(lib, /target\.is_minimized\(\)/);
  assert.match(lib, /webview\.controller\(\)\.SetIsVisible\(visible\)/);
});

// A hidden page gets its timers throttled (then one wake-up per minute after
// 5 min): the status poll that hands over to the next track must keep running.
test("hidden-page timer throttling is off and wry's defaults are kept", async () => {
  const conf = JSON.parse(await read("../src-tauri/tauri.conf.json"));
  const args = conf.app.windows[0].additionalBrowserArgs || "";
  for (const flag of ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "IntensiveWakeUpThrottling", "msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
});

// Each progress repaint re-composites the player's blurred glass: repaint only
// when the fill moves a pixel or the displayed second changes.
test("the progress bar repaints only on a visible change", async () => {
  const main = await read("../src/main.js");
  assert.match(main, /step: width > 0 \? Math\.max\(0\.05, max \/ width\) : 0\.05/);
  assert.match(main, /Math\.abs\(p - _lastSeekVal\) >= step \|\| Math\.floor\(p\) !== Math\.floor\(_lastSeekVal\)/);
  assert.doesNotMatch(main, /if \(Math\.abs\(p - _lastSeekVal\) > 0\.05\) renderSeek\(p\);/);
});
