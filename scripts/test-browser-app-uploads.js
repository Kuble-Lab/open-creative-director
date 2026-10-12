'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runBrowserTest, ready, status } = require('./support/browser');

runBrowserTest('test-browser-app-uploads.js', async ({ page, temp, workflow, open, calls }) => {
  const id = await workflow({ approval: true, uploads: true });
  const png = path.join(temp, 'pixel.png');
  const wav = path.join(temp, 'tone.wav');
  await fs.writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const audio = Buffer.alloc(44 + 1600);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(1600, 40);
  await fs.writeFile(wav, audio);
  await open(id);
  for (const [kind, file] of [['image', png], ['audio', wav]]) {
    const uploaded = page.waitForResponse(response => response.url().includes(`/api/workflows/${id}/uploads`) && response.request().method() === 'POST');
    await (await page.$(`.nv-appfields input[type=file][accept*="${kind}"]`)).uploadFile(file);
    assert.equal((await uploaded).status(), 200);
  }
  await page.$eval('.nv-appfields textarea', element => {
    element.value = 'A saved browser brief'; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('.nv-appfields img');
  await page.waitForSelector('.nv-appfields audio');
  await ready(page);
  const submission = page.waitForRequest(request => request.url().endsWith(`/api/workflows/${id}/runs`) && request.method() === 'POST');
  await page.click('.nv-apprun');
  const submitted = JSON.parse((await submission).postData()).overrides;
  await status(page, 'completed');
  await page.waitForSelector('.nv-appswitches [role=switch]:not([disabled])', { visible: true });
  await page.click('.nv-appswitches [role=switch]:not([disabled])');
  await page.waitForSelector('.nv-appswitches [role=switch][aria-checked=false]');
  const before = await page.$$eval('.nv-appfields img, .nv-appfields audio', elements => elements.map(element => element.getAttribute('src')));
  const executed = calls.slice();
  const plans = [];
  page.on('request', request => {
    if (request.url().endsWith(`/api/workflows/${id}/runs/plan`)) plans.push(JSON.parse(request.postData()));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.nv-appswitches [role=switch][aria-checked=false]:not([disabled])', { visible: true });
  assert.equal(await page.$eval('.nv-appfields textarea', element => element.value), 'A saved browser brief');
  assert.deepEqual(await page.$$eval('.nv-appfields img, .nv-appfields audio', elements => elements.map(element => element.getAttribute('src'))), before);
  assert.deepEqual(calls, executed, 'reload must never execute a node');
  assert(plans.length > 0, 'reload plans the restored inputs');
  const overrides = plans.findLast(plan => plan.mode === 'all').overrides;
  assert(overrides.photo.asset.assetId && overrides.audio.asset.assetId, 'both files restored as asset values');
  assert.deepEqual(overrides.photo.asset, submitted.photo.asset, 'the exact image cache value survives reload');
  assert.deepEqual(overrides.audio.asset, submitted.audio.asset, 'the exact audio cache value survives reload');
  assert.equal(overrides.preview.choice.p0, 'off', 'the unsubmitted switch is restored into the next approval request');
  for (const value of [overrides.photo.asset, overrides.audio.asset]) {
    assert.equal(value.createdAt, undefined, 'upload metadata must not contaminate cache keys');
    assert.equal(value.prompt, undefined, 'upload label must not contaminate cache keys');
  }
  assert.equal(calls.filter(call => call === 'preview').length, 1);
}).catch(error => { console.error(error); process.exitCode = 1; });
