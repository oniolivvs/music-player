import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function schedulePreload(');
const fn = source.slice(start, source.indexOf('\n}', start) + 2);
function harness(startSource) {
  const c = vm.createContext({ playSeq:1, curIndex:0, queue:['a','b','c'], playing:true,
    _preloadFor:null, queueSettled:true, preIndex:-1, expectedQueued:1,
    S:()=>({preloadNext:true}), nextIndex:i=>i+1, effectivePath:p=>p,
    trackByPath:()=>({}), gainFor:()=>1, startSource, console:{warn(){}},
  });
  vm.runInContext(fn, c);
  return c;
}
test('repeated settings changes do not append multiple next tracks', async () => {
  const calls=[]; const c=harness(async (...args)=>calls.push(args));
  await c.schedulePreload(); await c.schedulePreload(); await c.schedulePreload();
  assert.equal(calls.length,1);
  c.curIndex=1; await c.schedulePreload();
  assert.equal(calls.length,2,'the next hand-off still preloads its successor');
});
test('a late preload rejection cannot reset the new playback queue', async () => {
  let reject; const c=harness(()=>new Promise((_,r)=>{reject=r;}));
  const old=c.schedulePreload();
  c.playSeq=2; c.preIndex=2; c.expectedQueued=2; c.queueSettled=true;
  reject(new Error('obsolete')); await old;
  assert.equal(c.preIndex,2); assert.equal(c.expectedQueued,2); assert.equal(c.queueSettled,true);
});

const warmStart = source.indexOf("function scheduleArtworkWarmup(");
const warmFn = warmStart >= 0 ? source.slice(warmStart, source.indexOf("\n}", warmStart) + 2) : "function scheduleArtworkWarmup() {}";

function warmHarness({ playing = true, expectedSeq = 1, thumbnail = "next.jpg" } = {}) {
  const prepared = [];
  const context = vm.createContext({
    playSeq: 1,
    playing,
    curIndex: 0,
    queue: ["current", "next"],
    nextIndex: () => 1,
    effectivePath: path => path,
    trackByPath: path => path === "next" ? { artist: "A", album: "B", thumbnail } : null,
    albumKey: () => "A|||B",
    coverCache: new Map(),
    prepareArtworkData: source => { prepared.push(source); return Promise.resolve(); },
    window: { requestIdleCallback: callback => callback() },
    setTimeout: callback => callback(),
  });
  vm.runInContext(warmFn, context);
  context.scheduleArtworkWarmup(expectedSeq);
  return prepared;
}

test("artwork warmup prepares the next known cover after playback starts", () => {
  assert.deepEqual(warmHarness(), ["next.jpg"]);
});

test("artwork warmup does not run before playback or for stale playback", () => {
  assert.deepEqual(warmHarness({ playing: false }), []);
  assert.deepEqual(warmHarness({ expectedSeq: 0 }), []);
});

test("artwork warmup skips an unknown next cover", () => {
  assert.deepEqual(warmHarness({ thumbnail: "" }), []);
});
