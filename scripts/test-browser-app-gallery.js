'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runBrowserTest, ready, status } = require('./support/browser');

// The pure part of the gallery (public/nodes/app-mode.js): every leaf of every output in one flat row.
(function pureFunctions() {
  const window = { OCDNodes: { graph: {}, ui: { el: () => ({}), icon: () => ({}), T: (key) => key }, api: {}, run: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'nodes', 'app-mode.js'), 'utf8'), { window, localStorage: undefined, console });
  const { galleryItems, resultsViewOf, portraitRatio } = window.OCDNodes.appMode;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const image = (id) => ({ type: 'image', id });
  assert.deepEqual(plain(galleryItems([
    { node: 'a', label: 'Keyframes', leaves: [image('k1'), image('k2')] },
    { node: 'b', label: 'Film', leaves: [{ type: 'video', id: 'v' }] },
    { node: 'c', label: 'Leer', leaves: [] }
  ])), [
    { node: 'a', value: image('k1'), index: 0, count: 2, label: 'Keyframes 1' },
    { node: 'a', value: image('k2'), index: 1, count: 2, label: 'Keyframes 2' },
    { node: 'b', value: { type: 'video', id: 'v' }, index: 0, count: 1, label: 'Film' }
  ], 'the outputs keep their order, a leaf of several carries its number');
  assert.deepEqual(plain(galleryItems(null)), []);
  assert.equal(resultsViewOf('gallery'), 'gallery');
  assert.equal(resultsViewOf('list'), 'list');
  assert.equal(resultsViewOf(null), 'list', 'the list stays the default');
  assert.equal(resultsViewOf('tiles'), 'list', 'an unknown stored value falls back to the list');
  // a portrait film shapes its tile, any other keeps the tile of the view
  assert.equal(portraitRatio(1080, 1920), 0.5625, 'a 9:16 clip gets a 9:16 tile');
  assert.equal(portraitRatio(1080, 1350), 0.8);
  assert.equal(portraitRatio(600, 1920), 0.5625, 'not narrower than 9:16');
  assert.equal(portraitRatio(1080, 1080), null);
  assert.equal(portraitRatio(1920, 1080), null);
  assert.equal(portraitRatio(0, 0), null, 'a film whose size is not known yet');
})();

runBrowserTest('test-browser-app-gallery.js', async ({ page, workflow, open }) => {
  const id = await workflow({ approval: true });
  await open(id);
  await ready(page);
  const pressed = () => page.$$eval('.nv-appviewsw-btn', (buttons) => buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.dataset.view));
  assert.deepEqual(await pressed(), ['list'], 'the list is the default view');
  assert.equal(await page.$('.nv-appgal'), null);

  // before the run: the gallery shows one waiting tile per output
  await page.click('.nv-appviewsw-btn[data-view="gallery"]');
  await page.waitForSelector('.nv-appoutputs.is-gallery .nv-appgal');
  assert.deepEqual(await pressed(), ['gallery']);
  assert.equal(await page.$$eval('.nv-appgal-tile.is-empty', (tiles) => tiles.length), 2, 'every output without a result has a waiting tile');
  assert.equal(await page.$('.nv-appout'), null, 'the cards of the list are gone');

  await page.click('.nv-apprun');
  await status(page, 'completed');
  await page.waitForSelector('.nv-appgal-tile:not(.is-empty)');
  assert.equal(await page.$$eval('.nv-appgal-tile:not(.is-empty)', (tiles) => tiles.length), 1, 'the result of step 1 is a tile');
  assert.equal(await page.$$eval('.nv-appgal-tile.is-empty', (tiles) => tiles.length), 1, 'the output of the later step still waits');
  // the switches of the output live on its card: the gallery points to the list
  await page.waitForSelector('.nv-appgal-note');
  assert.equal(await page.$('.nv-appswitches'), null);

  // a click opens the large view
  await page.click('.nv-appgal-tile:not(.is-empty) .nv-appgal-frame');
  await page.waitForSelector('.nv-viewer');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.nv-viewer'));

  // the choice survives a reload
  await open(id);
  await page.waitForSelector('.nv-appgal-tile:not(.is-empty)');
  assert.deepEqual(await pressed(), ['gallery'], 'the view is remembered');

  // and back: the list with its switches
  await page.click('.nv-appgal-note .nv-btn');
  await page.waitForSelector('.nv-appout');
  await page.waitForSelector('.nv-appswitches [role=switch]');
  assert.deepEqual(await pressed(), ['list']);
  assert.equal(await page.$('.nv-appgal'), null);
}).catch(error => { console.error(error); process.exitCode = 1; });
