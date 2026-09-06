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
