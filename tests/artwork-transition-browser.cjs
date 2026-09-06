const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.setContent(read('index.html').replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''));
    await page.addStyleTag({ content: read('style.css') });

    const result = await page.evaluate(async () => {
      document.body.className = 'has-bg artwork-theme';
      document.documentElement.style.setProperty('--app-bg-image', 'url("data:image/png;base64,aaa")');
      document.documentElement.style.setProperty('--app-bg-next-image', 'url("data:image/png;base64,bbb")');
      document.documentElement.style.setProperty('--artwork-next-zoom', '1.35');

      const beforeStyle = getComputedStyle(document.body, '::before');
      const afterStyle = getComputedStyle(document.body, '::after');

      const beforeImage = beforeStyle.backgroundImage;
      const afterImage = afterStyle.backgroundImage;
      const initialAfterOpacity = afterStyle.opacity;
      const initialAfterTransition = afterStyle.transition;

      document.body.classList.add('artwork-crossfade');
      await new Promise(resolve => setTimeout(resolve, 350));
      const crossfadeAfterOpacity = getComputedStyle(document.body, '::after').opacity;

      document.body.classList.add('no-anim');
      const noAnimTransition = getComputedStyle(document.body, '::after').transition;

      return {
        beforeImage,
        afterImage,
        initialAfterOpacity,
        initialAfterTransition,
        crossfadeAfterOpacity,
        noAnimTransition,
      };
    });

    console.log(JSON.stringify(result, null, 2));

    assert.match(result.beforeImage, /data:image\/png;base64,aaa/, '::before must hold current image');
    assert.match(result.afterImage, /data:image\/png;base64,bbb/, '::after must hold next incoming image');
    assert.equal(result.initialAfterOpacity, '0', '::after opacity must be 0 before crossfade');
    assert.match(result.initialAfterTransition, /opacity\s*(?:0\.18s|180ms)/, '::after transition must animate opacity for 180ms');
    assert.equal(result.crossfadeAfterOpacity, '1', '::after opacity must be 1 with artwork-crossfade class');
    assert.match(result.noAnimTransition, /none|0s/, 'no-anim or reduced motion must disable transition');
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
