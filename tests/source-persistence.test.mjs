import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");

test("empty source folders remain visible and are never auto-pruned", () => {
  assert.match(main, /function renderSources\(\)[\s\S]*?const shown = folders;/);
  assert.doesNotMatch(main, /pruneEmptySources|Nothing playable[^\n]*not added/);
});

test("a successful empty scan still registers and persists the source", () => {
  const body = main.match(/async function addSource\(path\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(body, /if \(!folders\.includes\(path\)\) folders\.push\(path\);/);
  assert.match(body, /await saveLibrary\(\);/);
  assert.doesNotMatch(body, /if \(found\.length\)/);
});

test("download destinations become persisted sources", () => {
  assert.match(main, /dir = dirOf\(file\);[\s\S]{0,240}if \(dir && !folders\.includes\(dir\)\) folders\.push\(dir\);/);
  assert.match(main, /if \(!folders\.includes\(downloadRoot\)\) \{[\s\S]{0,180}folders\.push\(downloadRoot\);[\s\S]{0,100}await saveLibrary\(\);/);
});
