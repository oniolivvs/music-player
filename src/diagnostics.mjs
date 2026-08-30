const MAX_DETAIL = 4_000;
const MAX_ENTRIES = 200;
const MAX_PENDING = 100;

const clampText = (value, limit = MAX_DETAIL) => String(value ?? "").slice(0, limit);

function detailPart(value) {
  if (value instanceof Error || (value && typeof value === "object" && "message" in value)) {
    const name = clampText(value.name || "Error", 80);
    const message = clampText(value.message || value, 1_000);
    const stack = clampText(value.stack || "", 2_800);
    return stack ? `${name}: ${message}\n${stack}` : `${name}: ${message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function consoleEvent(level, args) {
  const first = typeof args[0] === "string" ? args[0] : "";
  const match = /^\[([^\]]{1,64})\]/.exec(first);
  return {
    level,
    component: match ? match[1] : "frontend",
    event: level === "error" ? "console_error" : "console_warn",
    detail: clampText(args.map(detailPart).join(" ")),
  };
}

export function createDiagnostics({ nativeInvoke, consoleRef = console, eventTarget = globalThis } = {}) {
  const memory = [];
  const originals = {
    error: typeof consoleRef?.error === "function" ? consoleRef.error : () => {},
    warn: typeof consoleRef?.warn === "function" ? consoleRef.warn : () => {},
  };
  let started = false;
  let pendingNative = 0;
  let chain = Promise.resolve();
  let patchedError;
  let patchedWarn;

  function remember(entry) {
    memory.push({
      ts_ms: Date.now(),
      session: "browser",
      ...entry,
    });
    if (memory.length > MAX_ENTRIES) memory.splice(0, memory.length - MAX_ENTRIES);
  }

  function enqueue(entry) {
    if (typeof nativeInvoke !== "function" || pendingNative >= MAX_PENDING) return;
    pendingNative++;
    chain = chain
      .then(() => nativeInvoke("diag_write", entry))
      .catch(() => {})
      .finally(() => { pendingNative--; });
  }

  function record(level, component, event, detail) {
    const entry = {
      level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
      component: clampText(component || "frontend", 64),
      event: clampText(event || "event", 64),
      detail: clampText(detail),
    };
    if (typeof nativeInvoke === "function") enqueue(entry);
    else remember(entry);
    return entry;
  }

  const onError = event => {
    const error = event?.error || event?.message || "Unhandled frontend error";
    record("error", "frontend", "window_error", detailPart(error));
  };
  const onUnhandledRejection = event => {
    const reason = event?.reason || "Unhandled promise rejection";
    record("error", "frontend", "unhandled_rejection", detailPart(reason));
  };

  function start() {
    if (started) return;
    started = true;
    patchedError = (...args) => {
      originals.error.apply(consoleRef, args);
      const entry = consoleEvent("error", args);
      record(entry.level, entry.component, entry.event, entry.detail);
    };
    patchedWarn = (...args) => {
      originals.warn.apply(consoleRef, args);
      const entry = consoleEvent("warn", args);
      record(entry.level, entry.component, entry.event, entry.detail);
    };
    consoleRef.error = patchedError;
    consoleRef.warn = patchedWarn;
    eventTarget?.addEventListener?.("error", onError);
    eventTarget?.addEventListener?.("unhandledrejection", onUnhandledRejection);
  }

  function stop() {
    if (!started) return;
    started = false;
    if (consoleRef.error === patchedError) consoleRef.error = originals.error;
    if (consoleRef.warn === patchedWarn) consoleRef.warn = originals.warn;
    eventTarget?.removeEventListener?.("error", onError);
    eventTarget?.removeEventListener?.("unhandledrejection", onUnhandledRejection);
  }

  async function tail(limit = MAX_ENTRIES) {
    const bounded = Math.max(0, Math.min(MAX_ENTRIES, Number(limit) || 0));
    if (typeof nativeInvoke === "function") {
      const entries = await nativeInvoke("diag_tail", { limit: bounded });
      return Array.isArray(entries) ? entries.slice(-bounded) : [];
    }
    return bounded ? memory.slice(-bounded) : [];
  }

  async function exportLog() {
    if (typeof nativeInvoke !== "function") return "Browser diagnostics stay in memory";
    return nativeInvoke("diag_export");
  }

  async function clear() {
    memory.length = 0;
    if (typeof nativeInvoke === "function") await nativeInvoke("diag_clear");
  }

  return {
    start,
    stop,
    record,
    tail,
    exportLog,
    clear,
    flush: () => chain,
  };
}
