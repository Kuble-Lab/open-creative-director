'use strict';
// A dialog taller than the window (the run review of a large workflow) scrolls with the mouse wheel until its buttons can be clicked,
// and the planned steps of the run review scroll in their own box.
const assert = require('node:assert/strict');
const { runBrowserTest } = require('./support/browser');

runBrowserTest('test-browser-dialog-scroll.js', async ({ page, workflow, open }) => {
  await page.setViewport({ width: 1000, height: 600 });
  const id = await workflow();
  await open(id, 'editor');
  await page.waitForFunction(id => window.OCDNodes.editor.getWorkflow()?.id === id, {}, id);
  await page.evaluate(() => {
    const body = document.createElement('div');
    for (let i = 0; i < 40; i += 1) {
      const line = document.createElement('p');
      line.textContent = `Step ${i + 1}: upstream step will run again`;
      body.append(line);
    }
    const changes = document.createElement('ul');
    changes.className = 'nv-confirm-list is-changes';
    for (let i = 0; i < 40; i += 1) {
      const row = document.createElement('li');
      row.textContent = `Node ${i + 1}: no cache`;
      changes.append(row);
    }
    body.append(changes);
    window.tallDialog = window.OCDNodes.ui.dialog({
      title: 'Review run',
      body,
      buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Run', value: true, primary: true }]
    });
  });
  await page.waitForSelector('.nv-dialog .nv-btn-primary');
  const below = await page.$eval('.nv-dialog .nv-btn-primary', button => button.getBoundingClientRect().top);
  assert.ok(below > 600, 'the buttons start below the window');
  const list = await page.$eval('.nv-confirm-list.is-changes', element => ({ height: element.clientHeight, content: element.scrollHeight }));
  assert.ok(list.height <= 180 && list.content > list.height, 'the planned steps scroll in their own box (at most 30 % of the window)');

  await page.mouse.move(500, 200);
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel({ deltaY: 400 });
  await page.waitForFunction(() => {
    const rect = document.querySelector('.nv-dialog .nv-btn-primary').getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  const point = await page.$eval('.nv-dialog .nv-btn-primary', button => {
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => window.tallDialog), true, 'the scrolled button answers the dialog');
  assert.equal(await page.$('.nv-dialog'), null);
}).catch(error => { console.error(error); process.exitCode = 1; });
