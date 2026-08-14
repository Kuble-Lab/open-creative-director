'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const rendernode = require('../lib/rendernode');
const costs = require('../lib/costs');
const { executeTool } = require('../lib/tools');

function compositionHtml(width, height) {
  return `<div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="3"></div>`;
}

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  const originalSubmit = rendernode.submit;
  const originalRecordCost = costs.recordCost;
  let submitted;

  rendernode.submit = async (html, quality, assets, resolution) => {
    submitted = { html, quality, assets, resolution };
    return { jobId: 'render-format-job', nodeId: 'node-00000001' };
  };
  costs.recordCost = async (entry) => entry;

  const ctx = { sessionId: session.id, emit() {}, user: 'test' };

  try {
    // Default: landscape
    await executeTool(ctx, 'render_motion_graphics', {
      html: compositionHtml(1920, 1080),
      label: 'Querformat-Test'
    });
    assert.equal(submitted.resolution, 'landscape', 'Default-Format muss landscape sein');

    // Portrait 9:16
    const portrait = await executeTool(ctx, 'render_motion_graphics', {
      html: compositionHtml(1080, 1920),
      label: 'Hochformat-Test',
      format: 'portrait'
    });
    assert.equal(submitted.resolution, 'portrait');
    assert.equal(portrait.job.format, 'portrait', 'Job muss das Format speichern');

    // Square 1:1
    await executeTool(ctx, 'render_motion_graphics', {
      html: compositionHtml(1080, 1080),
      label: 'Quadrat-Test',
      format: 'square'
    });
    assert.equal(submitted.resolution, 'square');

    // Mismatch: portrait angefordert, aber Querformat-Masse
    await assert.rejects(
      executeTool(ctx, 'render_motion_graphics', {
        html: compositionHtml(1920, 1080),
        label: 'Mismatch-Test',
        format: 'portrait'
      }),
      /1080x1920/
    );

    // Fehlende data-Attribute
    await assert.rejects(
      executeTool(ctx, 'render_motion_graphics', { html: '<div></div>', label: 'Ohne Masse' }),
      /data-width/
    );

    // Unbekanntes Format
    await assert.rejects(
      executeTool(ctx, 'render_motion_graphics', {
        html: compositionHtml(1920, 1080),
        label: 'Falsches Format',
        format: 'cinema'
      }),
      /landscape, portrait oder square/
    );

    console.log('render-format ok: landscape/portrait/square, Defaults, Mismatch- und Fehler-Faelle geprueft');
  } finally {
    rendernode.submit = originalSubmit;
    costs.recordCost = originalRecordCost;
    await store.deleteSession(session.id).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
