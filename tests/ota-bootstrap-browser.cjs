const { chromium } = require("playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const html = fs.readFileSync("src/index.html", "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const bootstrap = scripts.at(-1)?.[1];
    assert.ok(bootstrap?.includes("ota_bundle"), "OTA bootstrap not found");
    const manifest = JSON.parse(fs.readFileSync("ota.json", "utf8"));
    const modules = Object.fromEntries(manifest.modules.map(name => [name, fs.readFileSync(`src/${name}`, "utf8")]));
    const bundle = {
      version: manifest.version,
      entry: manifest.entry,
      css: fs.readFileSync(`src/${manifest.css}`, "utf8"),
      html,
      modules,
    };
    const page = await browser.newPage();
    const moduleErrors = [];
    page.on("pageerror", error => {
      if (/module specifier|Invalid URL|Failed to resolve/i.test(error.message)) moduleErrors.push(error.message);
    });
    await page.setContent(html.replace(/<script>[\s\S]*?<\/script>/g, ""));
    await page.evaluate(payload => {
      window.__TAURI__ = {
        core: { invoke: command => command === "ota_bundle" ? Promise.resolve(payload) : Promise.resolve(null) },
        app: { getVersion: () => Promise.resolve("0.0.0") },
        event: { listen: () => Promise.resolve(() => {}) },
      };
    }, bundle);
    await page.addScriptTag({ content: bootstrap });
    await page.waitForFunction(() => window.__MP_BOOTED__ === true, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    assert.deepEqual(moduleErrors, []);
    console.log(JSON.stringify({ version: manifest.version, modules: manifest.modules.length, booted: true }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
