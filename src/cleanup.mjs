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
      return lengthOrder || first.localeCompare(second);
    });
    return { keep: paths[0], remove: paths.slice(1) };
  });
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
