'use strict';
const assert = require('node:assert/strict');
const { runBrowserTest } = require('./support/browser');

runBrowserTest('test-browser-smoke.js', async ({ page, url, workflow, open }) => {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#input');
  assert.equal(await page.$eval('#input', element => element.tagName), 'TEXTAREA');
  const id = await workflow();
  await open(id, 'editor');
  await page.waitForFunction(id => window.OCDNodes.editor.getWorkflow()?.id === id, {}, id);
  assert.equal(await page.evaluate(() => window.OCDNodes.editor.getGraph().nodes.length), 6);
  await open(id);
  await page.waitForSelector('.nv-appfields textarea');
  assert.equal(await page.$eval('.nv-appfields textarea', element => element.value), 'Initial brief');
}).catch(error => { console.error(error); process.exitCode = 1; });
