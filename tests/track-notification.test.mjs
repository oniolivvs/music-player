import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Skipping through tracks sent one desktop toast per track: the notification
// must wait for 5 s of real playback of the same song.
test("track-change notifications wait for 5 s of real playback", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const nowPlaying = main.match(/function updateNowPlaying\(t, path\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(nowPlaying, "updateNowPlaying not found");
  assert.doesNotMatch(nowPlaying, /\bnotifyTrack\(/);
  assert.match(nowPlaying, /scheduleTrackNotification\(t, path \|\| t\?\.path \|\| ""\)/);
  assert.match(main, /const TRACK_NOTIFY_AFTER_SECS = 5;/);
  const schedule = main.match(/function scheduleTrackNotification[\s\S]*?\n\}/)?.[0] || "";
  assert.match(schedule, /clearInterval\(_trackNotifyTimer\)/);
  assert.match(schedule, /if \(playing\) played\+\+;/);
  assert.match(schedule, /played >= TRACK_NOTIFY_AFTER_SECS && wallPos\(\) >= TRACK_NOTIFY_AFTER_SECS\)/);
});
