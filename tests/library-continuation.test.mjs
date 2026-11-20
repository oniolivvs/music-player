import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickLibraryContinuation } from "../src/shuffle.mjs";
import { buildLibraryActions, renderLibraryActions } from "../src/library-actions.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const library = ["a", "b", "c", "d", "e"];

test("after a list ends, library songs follow one at a time in library order", () => {
  // The playlist held b and d: the library continues with what it has not played.
  assert.equal(pickLibraryContinuation(library, ["b", "d"]), "a");
  assert.equal(pickLibraryContinuation(library, ["b", "d", "a"]), "c");
  assert.equal(pickLibraryContinuation(library, ["b", "d", "a", "c"]), "e");
});

test("shuffle picks a library song at random, never one already queued", () => {
  const queue = ["a", "c"];
  for (const sample of [0, 0.34, 0.67, 0.9999]) {
    const pick = pickLibraryContinuation(library, queue, { shuffle: true, random: () => sample });
    assert.ok(["b", "d", "e"].includes(pick), pick);
  }
  assert.equal(pickLibraryContinuation(library, queue, { shuffle: true, random: () => 0 }), "b");
  assert.equal(pickLibraryContinuation(library, queue, { shuffle: true, random: () => 0.99 }), "e");
  assert.equal(pickLibraryContinuation(library, queue, { shuffle: true, random: () => NaN }), "b");
});

test("a list that already holds the whole library has nothing to add", () => {
  assert.equal(pickLibraryContinuation(library, [...library]), null);
  assert.equal(pickLibraryContinuation([], ["a"]), null);
});

test("the option is off by default and lives in Settings with its listener", () => {
  assert.match(read("src/settings.js"), /continueWithLibrary:\s*false/);
  const main = read("src/main.js");
  assert.match(main, /id="setContinueLib"/);
  assert.match(main, /\$\("#setContinueLib"\)\?\.addEventListener\("change"/);
  // The end of the list hands over to the library only when repeat is off.
  assert.match(main, /return continueFromLibrary\(\);\n\}/);
  assert.match(main, /function continueFromLibrary\(\)\s*\{\s*if \(!S\(\)\.continueWithLibrary \|\| repeatMode !== "off"/);
  // Shuffle grows its order instead of rebuilding it, so nothing played comes back.
  assert.match(main, /shufOrder = \[\.\.\.order, index\];\s*shufQueueSignature = shuffleSignature\(queue\);/);
});

test("every playlist gets the library's five actions, scoped to the playlist", () => {
  const actions = buildLibraryActions({ downloadableCount: 2, scope: "playlist" });
  assert.deepEqual(actions.map(action => action.id), ["plRefreshBtn", "plUrlBtn", "plDlBtn", "plDupsBtn", "plDeleteBlockedBtn"]);
  assert.match(actions[1].title, /this playlist/);
  assert.match(actions[4].title, /this playlist/);
  assert.equal(actions[4].cleanup, true);
  // Icon-only buttons are named by their tooltip, so it is never empty.
  const markup = renderLibraryActions(actions, () => "", value => String(value));
  assert.match(markup, /id="plDlBtn" class="btn-line sm" title="Save locally \(2 mp3\)"/);
  const main = read("src/main.js");
  assert.match(main, /buildLibraryActions\(\{ downloadableCount: nDl, scope: "playlist" \}\)/);
  assert.match(main, /deleteBlocked: \(\) => deleteBlockedTracks\(PL\.getPlaylists\(\)\.find\(p => p\.id === id\)\?\.paths \|\| \[\]\)/);
});

test("the list header is one row and the sidebar starts with the playlists", () => {
  const html = read("src/index.html");
  assert.doesNotMatch(html, /class="brand"|id="sideFilter"/);
  assert.match(html, /<span>Title<\/span>[\s\S]*<span class="lh-album">Album<\/span>/);
  for (const option of html.match(/<select id="sortSel"[\s\S]*?<\/select>/)[0].match(/<option[^>]*>[^<]*/g)) {
    assert.match(option, />Sort: /, option);
  }
  const main = read("src/main.js");
  assert.doesNotMatch(main, /#sideFilter/);
  // The sort control is taken out before the header is rewritten, then put back.
  assert.match(main, /const tools = \$\("#listTools"\);\s*tools\?\.remove\(\);[\s\S]*?head\.querySelector\("\.vh-actions"\)\.append\(tools\);/);
});

test("the sober skin has no lift, no per-tab colours and a compact header", () => {
  const css = read("src/style.css");
  assert.doesNotMatch(css, /--button-color/);
  // Nothing jumps under the pointer: hovers change surfaces, not positions.
  assert.doesNotMatch(css, /:hover[^{,]*\{[^}]*translateY\(-/);
  assert.match(css, /\.vh-title\s*\{[^}]*font-size:\s*20px/s);
  assert.match(css, /\.vh-icon\s*\{[^}]*width:\s*40px;\s*height:\s*40px/s);
  assert.match(css, /\.art\s*\{\s*width:\s*36px;\s*height:\s*36px/s);
  assert.match(css, /\.track\.playing,\s*body\.paused \.track\.playing\s*\{[^}]*color-mix\(in srgb, var\(--accent\) 12%/s);
});
