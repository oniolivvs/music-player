const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    const html = fs.readFileSync('src/index.html', 'utf8')
      .replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ content: fs.readFileSync('src/style.css', 'utf8') });
    const result = await page.evaluate(() => {
      const panel = document.querySelector('#npPanel');
      panel.hidden = false;
      panel.style.position = 'absolute';
      panel.style.left = '300px'; panel.style.top = '100px';
      panel.style.width = '330px'; panel.style.height = '400px';
      const handle = document.querySelector('#npResize');
      const panelRect = panel.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const button = document.querySelector('#navSources');
      button.classList.add('icon-text-control');
      const icon = button.querySelector('.ni-ico');
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 5h7l2 2h9v12H3z"/></svg>';
      const svgRect = icon.querySelector('svg').getBoundingClientRect();
      const labelRect = button.querySelector('.ni-lbl').getBoundingClientRect();
      return {
        topInset: handleRect.top - panelRect.top,
        bottomInset: panelRect.bottom - handleRect.bottom,
        iconTextDelta: (svgRect.top + svgRect.bottom - labelRect.top - labelRect.bottom) / 2,
      };
    });
    assert.ok(Math.abs(result.topInset) < 0.25, JSON.stringify(result));
    assert.ok(Math.abs(result.bottomInset) < 0.25, JSON.stringify(result));
    assert.ok(Math.abs(result.iconTextDelta + 1) < 0.25, JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
