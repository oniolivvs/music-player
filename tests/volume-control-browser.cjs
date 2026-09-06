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
      document.body.className = 'has-bg artwork-theme';
      const volume = document.querySelector('.volume').getBoundingClientRect();
      const slider = document.querySelector('#volume').getBoundingClientRect();
      const box = document.querySelector('.volume-pct').getBoundingClientRect();
      const input = document.querySelector('#volumePct');
      const sign = document.querySelector('.volume-pct-sign');
      const inputStyle = getComputedStyle(input);
      const signRect = sign.getBoundingClientRect();
      const center = box.top + box.height / 2;
      return {
        volumeHeight: volume.height,
        sliderHeight: slider.height,
        boxHeight: box.height,
        inputBackground: inputStyle.backgroundColor,
        inputAlpha: Number(inputStyle.backgroundColor.match(/rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([^)]+))?\)/)?.[1] ?? 1),
        signCenter: signRect.top + signRect.height / 2,
        boxCenter: center,
        signDisplay: getComputedStyle(sign).display,
        signTransform: getComputedStyle(sign).transform,
      };
    });
    assert.equal(result.inputAlpha, 0, JSON.stringify(result));
    assert.ok(Math.abs((result.signCenter - result.boxCenter) + 1) < 0.5, JSON.stringify(result));
    assert.ok(['flex', 'inline-flex'].includes(result.signDisplay), JSON.stringify(result));
    assert.equal(result.signTransform, 'matrix(1, 0, 0, 1, 0, -1)', JSON.stringify(result));
    assert.ok(Math.abs(result.volumeHeight - result.boxHeight) < 0.5, JSON.stringify(result));
    assert.ok(Math.abs(result.volumeHeight - result.sliderHeight) < 0.5, JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
