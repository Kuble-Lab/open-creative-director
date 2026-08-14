'use strict';

const assert = require('assert/strict');

const brandings = require('../lib/brandings');

async function main() {
  let branding;
  try {
    branding = await brandings.createBranding({
      name: '  Testmarke  ',
      description: '  Design-System fuer den Modultest  '
    });
    assert.match(branding.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(branding.name, 'Testmarke');

    branding = await brandings.updateBranding(branding.id, {
      colors: [
        { role: 'primary', name: 'Petrol', hex: '#123A4A', usage: 'Flaechen und CTA' },
        { role: 'accent', name: 'Koralle', hex: '#FF6846', usage: 'Akzente' }
      ],
      typography: [
        { role: 'headline', family: 'Inter', weights: '700', source: 'system', file: null, usage: 'Titel' }
      ],
      voice: { tone: 'Klar', language: 'de-CH', dos: 'Praezise', donts: 'Floskeln' },
      formats: [{ name: 'Instagram Post', aspect_ratio: '1:1', notes: 'Safe Area beachten' }],
      guidelines: 'Logo mit viel Weissraum einsetzen.'
    });
    assert.equal(branding.colors.length, 2);

    await assert.rejects(
      brandings.updateBranding(branding.id, { guidelines: 'x'.repeat(8001) }),
      /maximal 8000/
    );
    await assert.rejects(
      brandings.updateBranding(branding.id, {
        colors: Array.from({ length: 41 }, (_, index) => ({ hex: '#112233', name: `Farbe ${index}` }))
      }),
      /maximal 40/
    );
    await assert.rejects(
      brandings.updateBranding(branding.id, { colors: [{ hex: '#12345G' }] }),
      /Ungueltiger Farbwert/
    );
    await assert.rejects(
      brandings.saveBrandingAsset(branding.id, { buffer: Buffer.from('x'), filename: 'script.exe' }),
      /Dateityp nicht erlaubt/
    );
    await assert.rejects(
      brandings.saveBrandingAsset(branding.id, {
        buffer: Buffer.alloc(brandings.MAX_ASSET_BYTES + 1),
        filename: 'zu-gross.png'
      }),
      /maximal 50 MB/
    );

    const saved = await brandings.saveBrandingAsset(branding.id, {
      buffer: Buffer.from('testbild'),
      filename: '../../Logo Test.PNG'
    });
    const duplicate = await brandings.saveBrandingAsset(branding.id, {
      buffer: Buffer.from('testbild-2'),
      filename: 'Logo Test.PNG'
    });
    assert.equal(saved.filename, 'Logo-Test.png');
    assert.equal(duplicate.filename, 'Logo-Test-2.png');

    branding = await brandings.updateBranding(branding.id, {
      logos: [{ variant: 'primary', file: saved.file, usage: 'Standardlogo' }],
      motion: { outro: 'assets/outro.mp4', notes: 'Kurz und ruhig' },
      sound: [{ title: 'Signet', file: 'assets/signet.wav', usage: 'outro' }]
    });
    const summary = await brandings.brandingSummary(branding.id);
    assert.match(summary, /# Brand system: Testmarke/);
    assert.match(summary, /#123A4A/);
    assert.match(summary, /Inter/);
    assert.match(summary, /Logo-Test\.png/);
    assert.match(summary, /outro\.mp4/);
    assert.match(summary, /signet\.wav/);
    assert.match(summary, /Instagram Post: 1:1/);
    assert.match(summary, /Logo mit viel Weissraum/);

    const listed = await brandings.listBrandings();
    const preview = listed.find((entry) => entry.id === branding.id);
    assert.deepEqual(preview.colors, ['#123A4A', '#FF6846']);
    console.log('Brandings-Modul: CRUD, Validierung, Assets, Summary und Limits sind korrekt.');
  } finally {
    if (branding) await brandings.deleteBranding(branding.id).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
