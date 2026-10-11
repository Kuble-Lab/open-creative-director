'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { browserRuntime } = require('./support/browser');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocd-browser-runtime-'));
  const cache = path.join(root, 'cache');
  const options = { root, cache, executablePath: '' };
  try {
    assert.match(browserRuntime(options).skip, /puppeteer-core/);
    const moduleDir = path.join(root, 'render-node/node_modules/puppeteer-core');
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, 'index.js'), 'module.exports = {};');
    assert.match(browserRuntime(options).skip, /no cached Chrome/);
    for (const relative of ['chrome/linux-99.0/chrome-linux64/chrome', 'chrome/mac-102.0/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome/win32-103.0/chrome-win32/chrome.exe', 'chrome/win64-104.0/chrome-win64/chrome.exe', 'chrome-headless-shell/linux-100.0/chrome-headless-shell-linux64/chrome-headless-shell', 'chrome/mac_arm-101.0/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
      const file = path.join(cache, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '', { mode: 0o755 });
    }
    for (const [platform, arch, expected] of [
      ['linux', 'x64', /linux-100/], ['darwin', 'arm64', /mac_arm-101/],
      ['darwin', 'x64', /mac-102/], ['win32', 'ia32', /win32-103/], ['win32', 'x64', /win64-104/]
    ]) {
      assert.match(browserRuntime({ ...options, platform, arch }).executablePath, expected);
    }
    assert.match(browserRuntime({ ...options, platform: 'linux', arch: 'arm64' }).skip, /compatible with linux\/arm64/);
    const foreignCache = path.join(cache, 'chrome', 'mac_arm-101.0');
    assert.match(browserRuntime({ ...options, cache: foreignCache, platform: 'linux', arch: 'x64' }).skip, /no cached Chrome/);
    assert.equal(browserRuntime({ ...options, executablePath: process.execPath }).executablePath, process.execPath);
    assert.throws(() => browserRuntime({ ...options, executablePath: path.join(root, 'missing') }), /ENOENT/);
    // A broken installed package is a failure, not an optional-runtime skip.
    delete require.cache[require.resolve(moduleDir)];
    await fs.writeFile(path.join(moduleDir, 'index.js'), "require('./missing-dependency');");
    assert.throws(() => browserRuntime(options), /missing-dependency/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('test-browser-runtime.js: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
