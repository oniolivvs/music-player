// WebView2 keeps its browser shortcuts inside the app: F5 reloaded the whole
// interface mid-playback and Ctrl+P opened the print dialog. AltGr reads as
// Ctrl+Alt, and text editing (Ctrl+A/C/V/X/Y/Z) stays untouched.
const BROWSER_KEYS = new Set(["f3", "f5", "f7", "browserback", "browserforward", "browserrefresh", "browsersearch"]);
const BROWSER_CTRL_KEYS = new Set(["d", "f", "g", "h", "j", "l", "n", "o", "p", "r", "s", "t", "u", "w"]);
export function isBrowserShortcut(event) {
  const key = String(event.key || "").toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;
  if (BROWSER_KEYS.has(key)) return true;
  if (event.altKey && !ctrl) return key === "arrowleft" || key === "arrowright";
  return ctrl && !event.altKey && BROWSER_CTRL_KEYS.has(key);
}

// Classify by real content, not :only-child (which ignores text nodes).
export function updateButtonShape(button) {
  const iconOnly = !!button.querySelector('svg') && !button.textContent.trim();
  button.classList.toggle('icon-only-control', iconOnly);
  button.classList.toggle('icon-text-control', !iconOnly && !!button.querySelector('svg'));
}

export function observeButtonShapes(root = document.body) {
  root.querySelectorAll('button').forEach(updateButtonShape);
  const observer = new MutationObserver(records => {
    const buttons = new Set();
    for (const record of records) {
      const parent = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const button = parent?.closest('button');
      if (button) buttons.add(button);
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches('button')) buttons.add(node);
        node.querySelectorAll('button').forEach(button => buttons.add(button));
      }
    }
    buttons.forEach(updateButtonShape);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return observer;
}
