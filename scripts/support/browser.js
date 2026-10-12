'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

function browserRuntime({ root = ROOT, cache = path.join(os.homedir(), '.cache/puppeteer'), executablePath = process.env.OCD_TEST_BROWSER, platform = process.platform, arch = process.arch } = {}) {
  let puppeteer;
  let modulePath;
  try { modulePath = require.resolve(path.join(root, 'render-node/node_modules/puppeteer-core')); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return { skip: 'render-node/node_modules/puppeteer-core is not installed' };
  }
  puppeteer = require(modulePath);
  if (executablePath) {
    fs.accessSync(executablePath, fs.constants.X_OK);
    return { puppeteer, executablePath };
  }
  const cachePlatform = { 'darwin:arm64': 'mac_arm', 'darwin:x64': 'mac', 'linux:x64': 'linux',
    'win32:x64': 'win64', 'win32:ia32': 'win32' }[`${platform}:${arch}`];
  const candidates = [];
  function walk(dir, depth) {
    if (depth > 7 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (['chrome', 'chrome-headless-shell', 'Google Chrome for Testing', 'chrome.exe', 'chrome-headless-shell.exe'].includes(entry.name)) {
        const build = path.relative(cache, file).split(path.sep).find(part => /^(linux|mac_arm|mac|win32|win64)-[\d.]+$/.test(part));
        if (!cachePlatform || !build?.startsWith(`${cachePlatform}-`)) continue;
        try { fs.accessSync(file, fs.constants.X_OK); candidates.push(file); } catch (_) { /* not executable */ }
      }
    }
  }
  walk(cache, 0);
  candidates.sort((a, b) => {
    const version = (file) => file.match(/(?:linux|mac_arm|mac|win32|win64)-([\d.]+)/)?.[1] || '0';
    return version(b).localeCompare(version(a), undefined, { numeric: true }) || a.localeCompare(b);
  });
  return candidates.length ? { puppeteer, executablePath: candidates[0] } : { skip: `no cached Chrome compatible with ${platform}/${arch}; set OCD_TEST_BROWSER to an executable` };
}

function initializeBrowserDocument() {
  // Puppeteer also injects this into opaque preview frames, which cannot use storage.
  if (window !== window.top) return;
  localStorage.setItem('vcd-lang', 'en');
}

async function runBrowserTest(filename, test) {
  const runtime = browserRuntime();
  if (runtime.skip) {
    console.log(`SKIP ${filename}: ${runtime.skip}`);
    console.log(`${filename}: ok`);
    return;
  }
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-browser-'));
  let browser, fixture;
  const deadline = setTimeout(() => {
    console.error(`${filename}: exceeded 85 seconds`);
    browser?.process()?.kill('SIGKILL');
    process.exit(1);
  }, 85000);
  try {
    fixture = await require('./browser-fixture').createFixture(temp);
    browser = await runtime.puppeteer.launch({ executablePath: runtime.executablePath, headless: true,
      userDataDir: path.join(temp, 'profile'), timeout: 15000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-background-networking'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(15000);
    await page.evaluateOnNewDocument(initializeBrowserDocument);
    const errors = [];
    let disconnected = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !disconnected) errors.push(message.text()); });
    page.on('response', response => {
      if (response.url().startsWith(fixture.url) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', request => {
      if (!disconnected && request.url().startsWith(fixture.url) && request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(`${fixture.url}/`)) {
        errors.push(`External browser request: ${request.url()}`);
        void request.abort();
      } else void request.continue();
    });
    const open = async (id, mode = 'app') => {
      await page.goto(`${fixture.url}/#${mode === 'app' ? 'app' : 'w'}=${id}`, { waitUntil: 'load' });
      await page.waitForFunction((wanted) => window.OCDNodes?.editor?.getWorkflow()?.id === wanted ||
        document.querySelector('.nv-apprun'), {}, id);
      if (mode === 'app') await page.waitForSelector('.nv-apprun');
    };
    await test({ ...fixture, page, temp, open, errors, setDisconnected: value => { disconnected = value; } });
    assert.deepEqual(errors, [], 'no browser errors or failed local requests');
  } finally {
    if (browser) await browser.close();
    if (fixture) await fixture.close();
    await fsp.rm(temp, { recursive: true, force: true });
    clearTimeout(deadline);
  }
  console.log(`${filename}: ok`);
}

const status = (page, value) => page.waitForSelector(`.nv-appstatus[data-status="${value}"]`);
const ready = page => page.waitForFunction(() => {
  const button = document.querySelector('.nv-apprun');
  return button && !button.disabled;
});
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
module.exports = { browserRuntime, initializeBrowserDocument, runBrowserTest, status, ready, waitFor };
