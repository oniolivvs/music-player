import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBrowserShortcut } from "../src/ui-controls.mjs";
import { createRelinker } from "../src/library-actions.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const key = (name, mods = {}) => ({ key: name, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test("browser shortcuts stay out of the app window", () => {
  for (const event of [
    key("F5"), key("F5", { ctrlKey: true }), key("F3"), key("F7"), key("BrowserBack"),
    key("r", { ctrlKey: true }), key("R", { ctrlKey: true }), key("p", { ctrlKey: true }),
    key("f", { ctrlKey: true }), key("g", { ctrlKey: true }), key("u", { ctrlKey: true }),
    key("s", { ctrlKey: true }), key("o", { ctrlKey: true }), key("j", { ctrlKey: true }),
    key("ArrowLeft", { altKey: true }), key("ArrowRight", { altKey: true }),
  ]) assert.equal(isBrowserShortcut(event), true, JSON.stringify(event));
});

test("typing and text editing keep working", () => {
  for (const event of [
    key("a"), key("f"), key(" "), key("Enter"), key("Escape"), key("ArrowLeft"),
    key("a", { ctrlKey: true }), key("c", { ctrlKey: true }), key("v", { ctrlKey: true }),
    key("x", { ctrlKey: true }), key("y", { ctrlKey: true }), key("z", { ctrlKey: true }),
    // AltGr reads as Ctrl+Alt: "@" or "€" must still reach the text fields.
    key("e", { ctrlKey: true, altKey: true }), key("0", { ctrlKey: true, altKey: true }),
    key("f", { altKey: true }),
  ]) assert.equal(isBrowserShortcut(event), false, JSON.stringify(event));
});

test("the webview leaves drag and drop to the page", () => {
  // Windows only delivers dragover to the page with the native handler disabled:
  // with it on, a track row could be picked up but never dropped.
  const [window] = JSON.parse(read("src-tauri/tauri.conf.json")).app.windows;
  assert.equal(window.dragDropEnabled, false);
});

test("the window opens in the app's own background color", () => {
  // Without it Windows shows a white window for most of a second at every launch.
  const [window] = JSON.parse(read("src-tauri/tauri.conf.json")).app.windows;
  assert.match(read("src/style.css"), new RegExp(`--bg-0: ${window.backgroundColor};`));
});

test("file names come from either kind of path separator", () => {
  // String.split("/") returns a whole Windows path as its "file name".
  for (const file of ["src/main.js", "src/playlists.js", "src/settings.js"]) {
    assert.doesNotMatch(read(file), /\b(path|p)\b[^\n]*\.split\("\/"\)\.pop\(\)/, file);
  }
});

test("no update path rebuilds or resets a source tree", () => {
  const native = read("src-tauri/src/lib.rs");
  for (const word of ["reset", "podman", "distrobox", "bash"]) {
    assert.doesNotMatch(native, new RegExp(`"${word}"`), word);
  }
  const front = read("src/main.js");
  for (const command of ["self_update", "switch_version", "list_versions", "source_version"]) {
    assert.ok(!front.includes(`"${command}"`), command);
    assert.ok(!native.includes(`fn ${command}`), command);
  }
});

test("slow commands stay off the UI thread and off the async workers", () => {
  const sources = ["src-tauri/src/lib.rs", "src-tauri/src/library.rs", "src-tauri/src/youtube.rs", "src-tauri/src/mpris.rs"].map(read).join("\n");
  for (const name of ["seek", "canon_path", "canon_paths", "register_roots", "open_path", "yt_download_root", "yt_cleanup_download_root", "media_update"]) {
    assert.match(sources, new RegExp(`#\\[tauri::command\\]\\n(?:pub )?async fn ${name}\\([\\s\\S]*?\\n\\}\\n`), name);
    const body = sources.match(new RegExp(`async fn ${name}\\([\\s\\S]*?\\n\\}\\n`))[0];
    assert.match(body, /spawn_blocking/, name);
  }
});

test("a dead playlist path only follows a file that is clearly the same", () => {
  const library = [
    "E:\\music\\Song [dQw4w9WgXcQ].mp3",
    "E:\\music\\Unique.mp3",
    "E:\\music\\AlbumA\\01 Intro.mp3",
    "E:\\music\\AlbumB\\01 Intro.mp3",
  ];
  const dead = ["C:\\Old\\renamed [dQw4w9WgXcQ].mp3", "C:\\Old\\Unique.mp3", "C:\\Old\\01 Intro.mp3", "C:\\Old\\Gone.mp3", "C:\\X\\Twin.mp3", "C:\\Y\\Twin.mp3"];
  const relink = createRelinker([...library, "E:\\music\\Twin.mp3"], dead);
  assert.equal(relink(dead[0]), library[0]);
  assert.equal(relink(dead[1]), library[1]);
  assert.equal(relink(dead[2]), null, "two library files share this name");
  assert.equal(relink(dead[3]), null, "nothing has this name");
  assert.equal(relink(dead[4]), null, "two dead paths share this name");
});

test("yt-dlp output is decoded as UTF-8 on every path", () => {
  const source = read("src-tauri/src/youtube.rs");
  assert.match(source, /const YTDLP_UTF8: \[&str; 2\] = \["--encoding", "utf-8"\];/);
  assert.equal(source.match(/cmd\.args\(YTDLP_UTF8\);/g).length, 2);
  assert.doesNotMatch(source, /BufReader::new\(stdout\)\.lines\(\)/);
});
