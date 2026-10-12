'use strict';
// A switch with a hint (a boolean parameter with a paramhint): the label and the switch share the first line, the hint stands below
// them over the whole width and covers neither.
const assert = require('node:assert/strict');
const { runBrowserTest } = require('./support/browser');

runBrowserTest('test-browser-switch-hint.js', async ({ page, workflow, open }) => {
  await page.setViewport({ width: 1200, height: 800 });
  const id = await workflow();
  await open(id, 'editor');
  await page.waitForFunction(id => window.OCDNodes.editor.getWorkflow()?.id === id, {}, id);
  // a short label and one that wraps: the switch stays on the first line either way
  for (const label of ['Listen to the song', 'Listen to the song with the audio model before the brief and the plan are written']) {
    const box = await page.evaluate((label) => {
      const ui = window.OCDNodes.ui;
      const widget = ui.paramWidget({ id: 'listen', kind: 'boolean', default: true }, true, { onChange() {} });
      const hint = 'On: the song is heard once per plan (genre, mood, instruments and vocals), and the brief and the plan use it. Off: the plan comes from the song analysis alone.';
      const field = ui.field(label, widget.el, { inline: true, hint });
      const host = document.createElement('div');
      host.style.cssText = 'position: fixed; top: 20px; left: 20px; width: 280px; z-index: 9999;';
      host.append(field);
      document.body.append(host);
      const rect = (element) => element.getBoundingClientRect().toJSON();
      const result = { field: rect(field), label: rect(field.querySelector('.nv-field-label')), widget: rect(widget.el), hint: rect(field.querySelector('.nv-field-hint')) };
      host.remove();
      return result;
    }, label);
    const seen = JSON.stringify(box);
    assert.ok(Math.abs((box.label.top + box.label.bottom) / 2 - (box.widget.top + box.widget.bottom) / 2) < 8, `the label and the switch share a line: ${seen}`);
    assert.ok(box.widget.right >= box.field.right - 1 && box.widget.left > box.label.left, `the switch stands at the right edge: ${seen}`);
    assert.ok(box.hint.top >= Math.max(box.label.bottom, box.widget.bottom) - 0.5, `the hint stands below the label and the switch: ${seen}`);
    assert.ok(box.hint.width >= box.field.width - 1, `the hint takes the whole width: ${seen}`);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
