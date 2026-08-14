'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');
const brandings = require('../lib/brandings');
const { executeTool, toolDefinitions } = require('../lib/tools');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xkAAAAASUVORK5CYII=',
  'base64'
);

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  let brandingId;
  const events = [];
  const ctx = { sessionId: session.id, config: {}, emit: (event) => events.push(event), user: 'test' };

  try {
    const names = toolDefinitions().map((definition) => definition.function.name);
    for (const name of ['create_branding', 'update_branding', 'add_branding_asset', 'import_branding_asset']) {
      assert.ok(names.includes(name), `${name} muss immer verfuegbar sein`);
    }

    const created = await executeTool(ctx, 'create_branding', {
      name: 'Tool-Testmarke',
      description: 'Test der Director-Tools'
    });
    brandingId = /ID ([A-Za-z0-9_-]+)/.exec(created.toolResult)?.[1];
    assert.ok(brandingId);

    const updated = await executeTool(ctx, 'update_branding', {
      branding_id: brandingId,
      patch: {
        colors: [{ role: 'primary', name: 'Blau', hex: '#2244AA', usage: 'Primaer' }],
        guidelines: 'Konsequent und klar.'
      }
    });
    assert.match(updated.toolResult, /colors, guidelines/);

    const sourceAsset = await store.saveAsset(session.id, {
      kind: 'upload',
      buffer: PNG_1X1,
      ext: '.png',
      prompt: 'Tool-Testbild',
      cost: null
    });
    const added = await executeTool(ctx, 'add_branding_asset', {
      branding_id: brandingId,
      session_asset_id: sourceAsset.id,
      target: 'logo',
      meta: { variant: 'primary', usage: 'Standard' }
    });
    assert.match(added.toolResult, /als logo/);

    const branding = await brandings.readBranding(brandingId);
    assert.equal(branding.logos.length, 1);
    const filename = branding.logos[0].file.replace(/^assets\//, '');
    const beforeImport = await store.readLedger(session.id);
    const imported = await executeTool(ctx, 'import_branding_asset', {
      branding_id: brandingId,
      filename
    });
    const afterImport = await store.readLedger(session.id);
    assert.equal(afterImport.length, beforeImport.length + 1);
    assert.match(imported.toolResult, /Branding-Datei importiert/);
    assert.equal(imported.inject.length, 1);
    assert.equal(imported.inject[0].hidden, true);
    assert.equal(imported.inject[0].content[1].type, 'image_url');
    assert.ok(events.some((event) => event.type === 'asset'));
    console.log('Branding-Tools: Erstellen, Aktualisieren, Asset sichern und PNG mit Vorschau importieren sind korrekt.');
  } finally {
    if (brandingId) await brandings.deleteBranding(brandingId).catch(() => {});
    await store.deleteSession(session.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
