const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// WCAG contrast of two computed colours (alpha composited on white, the light
// scheme's panel base, which is the case this test renders).
function rgba(value) {
  const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
  return [r, g, b].map(c => c * a + 255 * (1 - a));
}
function luminance(rgb) {
  return rgb.map(c => c / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(fg, bg) {
  const [a, b] = [luminance(rgba(fg)), luminance(rgba(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const html = fs.readFileSync('src/index.html', 'utf8')
      .replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    const css = fs.readFileSync('src/style.css', 'utf8');
    const results = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 640, height: 720 }, { width: 367, height: 555 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(html);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => {
        document.body.classList.add('has-bg', 'artwork-theme', 'bg-light', 'np-open');
        const actions = document.createElement('div');
        actions.className = 'data-transfer-actions paired-actions';
        actions.style.width = '500px';
        actions.innerHTML = '<button class="btn">Export backup</button><button class="btn-line">Import backup</button>';
        document.body.append(actions);
        const row = document.createElement('div');
        row.className = 'track';
        row.innerHTML = '<span></span><span></span><span class="meta"><span class="t">Song</span><span class="s">Artist</span></span><span class="album">Album</span><span class="dur">1:00</span><span></span>';
        document.querySelector('#trackList').replaceChildren(row);
        const focusProbe = document.createElement('input');
        focusProbe.type = 'password';
        focusProbe.className = 'text-in';
        focusProbe.style.cssText = 'position:fixed;left:0;top:0;width:120px';
        document.body.append(focusProbe);
        focusProbe.focus();
        const dependencyToolbar = document.createElement('div');
        dependencyToolbar.className = 'dependency-toolbar';
        dependencyToolbar.style.cssText = 'position:fixed;left:0;top:50px';
        dependencyToolbar.innerHTML = '<button class="btn-line sm">Refresh</button><button class="btn sm">Install / repair all</button>';
        document.body.append(dependencyToolbar);
      });
      // Artwork mode fades colours in (500 ms): read them once it has settled.
      await page.waitForTimeout(800);
      const result = await page.evaluate(() => {
        const nav = document.querySelector('.nav-bar').getBoundingClientRect();
        const main = document.querySelector('.main').getBoundingClientRect();
        const player = document.querySelector('.player').getBoundingClientRect();
        const importer = document.querySelector('#importPlaylistBtn').getBoundingClientRect();
        const importerStyle = getComputedStyle(document.querySelector('#importPlaylistBtn'));
        const navBarBackground = getComputedStyle(document.querySelector('.nav-bar')).backgroundColor;
        const idleShuffle = getComputedStyle(document.querySelector('#shuffleBtn'));
        const idleShuffleColor = idleShuffle.color, idleShuffleBackground = idleShuffle.backgroundColor;
        const optionStyle = getComputedStyle(document.querySelector('#sortSel option[value="title"]'));
        const listTitleStyle = getComputedStyle(document.querySelector('#trackList .meta .t'));
        const listSubStyle = getComputedStyle(document.querySelector('#trackList .meta .s'));
        const paired = [...document.querySelectorAll('.data-transfer-actions > button')]
          .map(button => button.getBoundingClientRect());
        const dependencyButtons = [...document.querySelectorAll('.dependency-toolbar > button')]
          .map(button => button.getBoundingClientRect());
        const focusStyle = getComputedStyle(document.querySelector('input[type="password"]'));
        const shuffle = document.querySelector('#shuffleBtn');
        // Read the end state, not the first frame of its colour transition.
        shuffle.style.transition = 'none';
        shuffle.classList.add('active');
        const activeShuffle = getComputedStyle(shuffle);
        const nowPlaying = document.querySelector('#npPanel');
        nowPlaying.hidden = false;
        document.body.classList.add('np-open');
        document.documentElement.style.setProperty('--nav-bottom', `${nav.bottom}px`);
        document.documentElement.style.setProperty('--player-top', `${window.innerHeight - player.top}px`);
        const npBox = nowPlaying.getBoundingClientRect();
        const artBox = document.querySelector('#ovArt').getBoundingClientRect();
        return {
          bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          navBottom: nav.bottom, mainTop: main.top, mainBottom: main.bottom, playerTop: player.top,
          importerWidth: importer.width,
          importerColor: importerStyle.webkitTextFillColor || importerStyle.color,
          optionColor: optionStyle.color,
          optionBackground: optionStyle.backgroundColor,
          listTitleColor: listTitleStyle.color,
          listSubColor: listSubStyle.color,
          pairedWidthDelta: Math.max(...paired.map(box => box.width)) - Math.min(...paired.map(box => box.width)),
          pairedHeightDelta: Math.max(...paired.map(box => box.height)) - Math.min(...paired.map(box => box.height)),
          dependencyHeightDelta: Math.max(...dependencyButtons.map(box => box.height)) - Math.min(...dependencyButtons.map(box => box.height)),
          dependencyTopDelta: Math.max(...dependencyButtons.map(box => box.top)) - Math.min(...dependencyButtons.map(box => box.top)),
          dependencyHeight: dependencyButtons[0].height,
          focusedTextOutline: focusStyle.outlineStyle,
          navBarBackground,
          activeShuffleChanged: activeShuffle.color !== idleShuffleColor && activeShuffle.backgroundColor !== idleShuffleBackground,
          activeShuffleDot: getComputedStyle(shuffle, '::after').content,
          nowPlayingTop: npBox.top, nowPlayingRight: npBox.right, nowPlayingBottom: npBox.bottom,
          nowPlayingArtRight: artBox.right, nowPlayingArtBottom: artBox.bottom,
          nowPlayingFitsViewport: npBox.left >= -1 && npBox.right <= window.innerWidth + 1 && npBox.top >= nav.bottom,
          nowPlayingFitsPlayer: npBox.bottom <= player.top + 1,
          nowPlayingCenterDelta: Math.abs((npBox.left + npBox.right) / 2 - window.innerWidth / 2),
          shareCount: document.querySelectorAll('#navShare, #shareModal').length,
        };
      });
      assert.ok(result.bodyOverflow <= 1, JSON.stringify({ viewport, result }));
      assert.ok(result.navBottom <= result.mainTop + 1, JSON.stringify({ viewport, result }));
      assert.ok(result.mainBottom <= result.playerTop + 1, JSON.stringify({ viewport, result }));
      assert.ok(result.importerWidth > 0, JSON.stringify({ viewport, result }));
      assert.ok(contrast(result.importerColor, result.navBarBackground) >= 4.5, JSON.stringify({ viewport, result }));
      assert.equal(result.optionColor, 'rgb(17, 19, 24)', JSON.stringify({ viewport, result }));
      assert.equal(result.optionBackground, 'rgb(255, 255, 255)', JSON.stringify({ viewport, result }));
      assert.notEqual(result.listTitleColor, 'rgb(255, 255, 255)', JSON.stringify({ viewport, result }));
      assert.notEqual(result.listSubColor, 'rgb(255, 255, 255)', JSON.stringify({ viewport, result }));
      assert.ok(result.pairedWidthDelta <= 1, JSON.stringify({ viewport, result }));
      assert.ok(result.pairedHeightDelta <= 1, JSON.stringify({ viewport, result }));
      assert.ok(result.dependencyHeightDelta <= 0.1, JSON.stringify({ viewport, result }));
      assert.ok(result.dependencyTopDelta <= 0.1, JSON.stringify({ viewport, result }));
      assert.equal(result.dependencyHeight, 40, JSON.stringify({ viewport, result }));
      assert.equal(result.focusedTextOutline, 'none', JSON.stringify({ viewport, result }));
      assert.equal(result.activeShuffleChanged, true, JSON.stringify({ viewport, result }));
      assert.equal(result.activeShuffleDot, '""', JSON.stringify({ viewport, result }));
      assert.equal(result.nowPlayingFitsViewport, true, JSON.stringify({ viewport, result }));
      assert.equal(result.nowPlayingFitsPlayer, true, JSON.stringify({ viewport, result }));
      if (viewport.width <= 560) assert.ok(result.nowPlayingCenterDelta <= 1, JSON.stringify({ viewport, result }));
      assert.ok(result.nowPlayingArtRight <= result.nowPlayingRight + 1, JSON.stringify({ viewport, result }));
      assert.ok(result.nowPlayingArtBottom <= result.nowPlayingBottom + 1, JSON.stringify({ viewport, result }));
      assert.equal(result.shareCount, 0, JSON.stringify({ viewport, result }));
      results.push({ viewport, ...result });
      await page.close();
    }
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
