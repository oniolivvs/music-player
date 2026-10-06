import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

// A listener wired with `$("#id")?.addEventListener` silently does nothing when
// its markup is gone — that is how the Discord Rich Presence settings vanished
// while their handlers stayed. Every such id must exist in some markup.
test("every optional settings listener has its element in the markup", async () => {
  const [main, html] = await Promise.all([read("../src/main.js"), read("../src/index.html")]);
  const markup = new Set([...`${main}\n${html}`.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map(match => match[1]));
  const wired = new Set([...main.matchAll(/\$\("#([A-Za-z][\w-]*)"\)\?\.addEventListener/g)].map(match => match[1]));
  // Buttons the 2026 redesign removed on purpose; their listeners are inert.
  const removedByDesign = new Set(["sideToggle", "listRefreshBtn", "npClose", "npPin"]);
  const orphans = [...wired].filter(id => !markup.has(id) && !removedByDesign.has(id));
  assert.deepEqual(orphans, []);
});

test("Discord Rich Presence settings expose the Application ID and a test", async () => {
  const main = await read("../src/main.js");
  for (const id of ["setRpc", "setRpcId", "setRpcTest", "setRpcDelay", "setRpcPause", "setRpcStatus"]) {
    assert.match(main, new RegExp(`id="${id}"`), `${id} is missing from the settings markup`);
  }
  assert.match(main, /const RPC_APP_ID = \/\^\\d\{17,20\}\$\//);
});

// The progress loop stops while the window is hidden or the bar is dragged;
// only play/resume restarted it, so the bar froze while the music went on.
test("the progress loop restarts after hiding the window, a seek, or any poll", async () => {
  const main = await read("../src/main.js");
  assert.match(main, /addEventListener\("visibilitychange",[\s\S]{0,200}startProgressLoop\(\)/);
  assert.match(main, /if \(!_progRaf && !seeking && !document\.hidden\) startProgressLoop\(\);/);
  assert.match(main, /async function commitSeekSeconds[\s\S]{0,400}if \(playing\) startProgressLoop\(\);/);
});
