const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const html = fs.readFileSync('src/index.html', 'utf8')
      .replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    const css = fs.readFileSync('src/style.css', 'utf8');
    const results = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 640, height: 720 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(html);
      await page.addStyleTag({ content: css });
      const result = await page.evaluate(() => {
        const nav = document.querySelector('.nav-bar').getBoundingClientRect();
        const main = document.querySelector('.main').getBoundingClientRect();
        const player = document.querySelector('.player').getBoundingClientRect();
        const importer = document.querySelector('#importPlaylistBtn').getBoundingClientRect();
        return {
          bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          navBottom: nav.bottom, mainTop: main.top, mainBottom: main.bottom, playerTop: player.top,
          importerWidth: importer.width,
          shareCount: document.querySelectorAll('#navShare, #shareModal').length,
        };
      });
      assert.ok(result.bodyOverflow <= 1, JSON.stringify({ viewport, result }));
      assert.ok(result.navBottom <= result.mainTop + 1, JSON.stringify({ viewport, result }));
      assert.ok(result.mainBottom <= result.playerTop + 1, JSON.stringify({ viewport, result }));
      assert.ok(result.importerWidth > 0, JSON.stringify({ viewport, result }));
      assert.equal(result.shareCount, 0, JSON.stringify({ viewport, result }));
      results.push({ viewport, ...result });
      await page.close();
    }
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
