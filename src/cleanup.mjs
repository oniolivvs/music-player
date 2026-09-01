function compareCodePoints(first, second) {
  const firstPoints = first[Symbol.iterator]();
  const secondPoints = second[Symbol.iterator]();
  for (;;) {
    const left = firstPoints.next();
    const right = secondPoints.next();
    if (left.done || right.done) return left.done === right.done ? 0 : (left.done ? -1 : 1);
    const order = left.value.codePointAt(0) - right.value.codePointAt(0);
    if (order) return order;
  }
}

export function buildCleanupActionLayout({
  deleteBlocked = "",
  deleteFiles = "",
  deletePlaylistEntries = "",
  playlistSelector = "",
} = {}) {
  return `
    <div class="cleanup-delete-actions">
      ${deleteBlocked}
      ${deleteFiles}
      ${deletePlaylistEntries}
    </div>
    <div class="cleanup-playlist-scope">
      <label for="setCleanupPlaylist">Playlist scope</label>
      ${playlistSelector}
    </div>`;
}

export function chooseDuplicatePlan(groups = [], playlists = []) {
  const references = new Map();
  for (const playlist of playlists) {
    for (const path of playlist?.paths || []) {
      references.set(path, (references.get(path) || 0) + 1);
    }
  }

  return groups.map(group => {
    const paths = [...(group?.paths || [])].sort((first, second) => {
      const referenceOrder = (references.get(second) || 0) - (references.get(first) || 0);
      if (referenceOrder) return referenceOrder;
      const lengthOrder = first.length - second.length;
      return lengthOrder || compareCodePoints(first, second);
    });
    return { keep: paths[0], remove: paths.slice(1) };
  });
}

// Discovery only proposes a delete plan. References move only after the native
// confirmation command says that exact path was still an equal duplicate and
// was actually unlinked; absent/failed outcomes stay untouched.
export function duplicateConfirmationResults(plan = [], outcomes = []) {
  const outcomeByPath = new Map((outcomes || []).map(outcome => [outcome?.path, outcome]));
  const replacements = new Map();
  const failures = new Map();
  for (const group of plan || []) {
    for (const path of group?.remove || []) {
      const outcome = outcomeByPath.get(path);
      if (outcome?.deleted) replacements.set(path, group.keep);
      else failures.set(path, outcome?.error || "duplicate confirmation returned no result");
    }
  }
  return { replacements, failures };
}

export function rewritePaths(paths, replacements, removed) {
  const result = [];
  const seen = new Set();
  for (const path of paths) {
    const rewritten = replacements.get(path) ?? path;
    if (removed.has(rewritten) || seen.has(rewritten)) continue;
    seen.add(rewritten);
    result.push(rewritten);
  }
  return result;
}

export function dedupePlaylistPaths(paths, identityByPath) {
  const result = [];
  const identities = new Set();
  for (const path of paths) {
    const identity = identityByPath.get(path) || "path:" + path;
    if (identities.has(identity)) continue;
    identities.add(identity);
    result.push(path);
  }
  return { paths: result, removed: paths.length - result.length };
}

export function collectBlockedPaths(candidatePaths, blockedKeys, blockKeyByPath) {
  const result = [];
  const seen = new Set();
  for (const path of candidatePaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (blockedKeys.has(blockKeyByPath.get(path))) result.push(path);
  }
  return result;
}

// A block key represents one source identity, not merely one path. Clear it
// only after a successful deletion, and retain it if another candidate sharing
// the same identity failed in this cleanup pass.
export function clearSuccessfulBlockKeys(blockedKeys, removedPaths, failedPaths, blockKeyByPath) {
  const next = new Set(blockedKeys);
  const failedKeys = new Set();
  for (const path of failedPaths) {
    const key = blockKeyByPath.get(path);
    if (key) failedKeys.add(key);
  }
  for (const path of removedPaths) {
    const key = blockKeyByPath.get(path);
    if (key && !failedKeys.has(key)) next.delete(key);
  }
  return next;
}

export function removeQueuePaths(queue, currentIndex, removed) {
  const active = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : undefined;
  const activeRemoved = active !== undefined && removed.has(active);
  const nextQueue = queue.filter(path => !removed.has(path));

  if (!nextQueue.length) return { queue: nextQueue, currentIndex: -1, activeRemoved };

  if (!activeRemoved) {
    if (active === undefined) return { queue: nextQueue, currentIndex: -1, activeRemoved: false };
    const nextIndex = queue
      .slice(0, currentIndex + 1)
      .filter(path => !removed.has(path)).length - 1;
    return { queue: nextQueue, currentIndex: nextIndex, activeRemoved: false };
  }

  const nextOriginalIndex = queue.findIndex((path, index) => index > currentIndex && !removed.has(path));
  const targetIndex = nextOriginalIndex === -1
    ? nextQueue.length - 1
    : queue.slice(0, nextOriginalIndex + 1).filter(path => !removed.has(path)).length - 1;
  return { queue: nextQueue, currentIndex: targetIndex, activeRemoved: true };
}

// Duplicate cleanup changes paths as well as removing repetitions. Resolve the
// active *occurrence* while walking the source queue: `indexOf` finds the first
// keeper and loses a later active duplicate before we can restart playback.
export function rewriteQueuePaths(queue, currentIndex, replacements, removed) {
  const activeIndex = currentIndex >= 0 && currentIndex < queue.length ? currentIndex : -1;
  const activePath = activeIndex === -1 ? undefined : queue[activeIndex];
  const nextQueue = [];
  const firstIndexByPath = new Map();
  let nextActiveIndex = -1;
  let activeRemoved = false;
  let activeChanged = false;

  for (let index = 0; index < queue.length; index++) {
    const original = queue[index];
    const rewritten = replacements.get(original) ?? original;
    if (removed.has(rewritten)) {
      if (index === activeIndex) activeRemoved = true;
      continue;
    }

    let nextIndex = firstIndexByPath.get(rewritten);
    if (nextIndex === undefined) {
      nextIndex = nextQueue.length;
      firstIndexByPath.set(rewritten, nextIndex);
      nextQueue.push(rewritten);
    }
    if (index === activeIndex) {
      nextActiveIndex = nextIndex;
      activeChanged = rewritten !== activePath;
    }
  }

  if (!nextQueue.length) return { queue: nextQueue, currentIndex: -1, activeChanged: activeIndex !== -1 };
  if (activeIndex === -1) return { queue: nextQueue, currentIndex: -1, activeChanged: false };
  if (!activeRemoved) return { queue: nextQueue, currentIndex: nextActiveIndex, activeChanged };

  // Same successor policy as a deletion: choose the next surviving occurrence,
  // otherwise the final surviving one. The map preserves an occurrence that
  // collapsed into an earlier equal path without a global `indexOf` lookup.
  for (let index = activeIndex + 1; index < queue.length; index++) {
    const rewritten = replacements.get(queue[index]) ?? queue[index];
    if (!removed.has(rewritten)) {
      return {
        queue: nextQueue,
        currentIndex: firstIndexByPath.get(rewritten),
        activeChanged: true,
      };
    }
  }
  return { queue: nextQueue, currentIndex: nextQueue.length - 1, activeChanged: true };
}

// JSON is intentionally used instead of a first/last shortcut: it represents
// every occurrence and ordering change that must be persisted for resume.
export function queueSignature(queue) {
  return JSON.stringify(queue);
}

export function createGenerationGuard() {
  let generation = 0;
  return {
    current: () => generation,
    advance: () => ++generation,
    isCurrent: value => value === generation,
  };
}

// Every playback transition that can race cleanup goes through this small
// boundary. Advancing before applying the state guarantees an awaiting cleanup
// observes the change even when the transition itself is synchronous.
export function runPlaybackTransition(guard, transition) {
  guard.advance();
  return transition();
}

// Persist one atomic snapshot. If playback moves while storage is in flight,
// retry from the newest state; success is reported only for a generation that
// stayed stable for the complete write. The initial generation must still be
// current so a cleanup that lost the race before persistence cannot start.
export async function persistLatestGeneration(
  guard,
  initialGeneration,
  capture,
  persist,
  maxAttempts = 3,
) {
  if (!guard.isCurrent(initialGeneration)) {
    throw new Error("Playback changed during cleanup");
  }

  let generation = initialGeneration;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const snapshot = capture();
    await persist(snapshot);
    if (guard.isCurrent(generation)) return snapshot;
    generation = guard.current();
  }
  throw new Error("Playback changed during cleanup");
}

// Keep cleanup persistence causal. An error deliberately rejects so callers do
// not show a successful cleanup after filesystem changes that were not saved.
export async function persistInOrder(steps = []) {
  for (const persist of steps) await persist();
}

export function buildCleanupSummary(items = []) {
  return items.reduce((summary, item) => {
    if (item?.failed) {
      summary.failed++;
      return summary;
    }
    summary.entries++;
    if (item?.local) {
      summary.files++;
      summary.bytes += Number(item.bytes) || 0;
    }
    return summary;
  }, { entries: 0, files: 0, failed: 0, bytes: 0 });
}
