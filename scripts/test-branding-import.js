'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const archiver = require('archiver');

const { app } = require('../server');
const brandings = require('../lib/brandings');
const brandingImport = require('../lib/branding-import');

function zipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    output.on('error', reject);
    output.on('end', () => resolve(Buffer.concat(chunks)));
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.buffer, { name: entry.name });
    archive.finalize().catch(reject);
  });
}

function replaceEvery(buffer, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to), 'ZIP-Pfad-Patch braucht gleiche Laengen');
  const patched = Buffer.from(buffer);
  const source = Buffer.from(from);
  const target = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while ((offset = patched.indexOf(source, offset)) !== -1) {
    target.copy(patched, offset);
    offset += target.length;
    replacements += 1;
  }
  assert.ok(replacements >= 2, `ZIP-Pfad ${from} wurde nicht in Lokal- und Zentralheader gefunden`);
  return patched;
}

function patchEntryCount(buffer, count) {
  const patched = Buffer.from(buffer);
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = patched.lastIndexOf(signature);
  assert.ok(offset >= 0, 'ZIP-Endheader fehlt');
  patched.writeUInt16LE(count, offset + 8);
  patched.writeUInt16LE(count, offset + 10);
  return patched;
}

function patchFirstUncompressedSize(buffer, bytes) {
  const patched = Buffer.from(buffer);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const offset = patched.indexOf(signature);
  assert.ok(offset >= 0, 'ZIP-Zentralheader fehlt');
  patched.writeUInt32LE(bytes, offset + 24);
  return patched;
}

function routeHandler(pathname, method) {
  const layer = app._router.stack.find((item) => item.route?.path === pathname && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${method.toUpperCase()} ${pathname}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeImport(buffer, { filename = 'claude-design.zip', name = '' } = {}) {
  const handler = routeHandler('/api/brandings/import', 'post');
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        resolve({ status: this.statusCode, body: value });
        return this;
      }
    };
    Promise.resolve(handler({
      body: buffer,
      query: { name },
      get(header) {
        return header.toLowerCase() === 'x-file-name' ? encodeURIComponent(filename) : '';
      }
    }, response)).catch(reject);
  });
}

async function main() {
  const createdIds = [];
  const stamp = Date.now();
  const escapedName = `evil-${stamp}.txt`;
  const safeMaliciousPath = `xx/${escapedName}`;
  const maliciousPath = `../${escapedName}`;
  const escapedTarget = path.join(brandings.BRANDINGS_DIR, escapedName);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">',
    '<rect width="320" height="120" fill="#123456"/>',
    '</svg>'
  ].join('');
  const css = [
    ':root {',
    '  --color-primary: #123456;',
    '  --color-accent: rgb(255, 102, 51);',
    '  --surface: hsl(210 20% 96%);',
    '}',
    '.title { font-family: "Test Font", sans-serif; }',
    '.body { font-family: "Body Sans", sans-serif; }'
  ].join('\n');
  const sourceZip = await zipBuffer([
    { name: '_ds_manifest.json', buffer: Buffer.from(JSON.stringify({ name: 'Claude Import Test', cards: [] })) },
    { name: 'tokens/tokens.css', buffer: Buffer.from(css) },
    { name: 'fonts/Test-Font-Regular.woff', buffer: Buffer.from('wOFF-dummy-font') },
    { name: 'assets/logo-primary.svg', buffer: Buffer.from(svg) },
    { name: 'images/hero.png', buffer: Buffer.from('dummy-png-reference') },
    { name: 'README.md', buffer: Buffer.from('# Claude Import Test\n\nKlare Regeln fuer Logo und Farben.') },
    { name: 'components/button.html', buffer: Buffer.from('<!-- @dsCard group="Controls" -->\n<button>CTA</button>') },
    { name: safeMaliciousPath, buffer: Buffer.from('darf nie geschrieben werden') }
  ]);
  const testZip = replaceEvery(sourceZip, safeMaliciousPath, maliciousPath);

  try {
    await fsp.rm(escapedTarget, { force: true });
    const response = await invokeImport(testZip);
    assert.equal(response.status, 201);
    assert.match(response.body.brandingId, /^[A-Za-z0-9_-]+$/);
    assert.equal(response.body.name, 'Claude Import Test');
    assert.deepEqual(
      {
        colors: response.body.report.colors,
        fonts: response.body.report.fonts,
        logos: response.body.report.logos,
        imagery: response.body.report.imagery,
        guidelines: response.body.report.guidelines,
        skipped: response.body.report.skipped
      },
      { colors: 3, fonts: 2, logos: 1, imagery: 1, guidelines: true, skipped: 2 }
    );
    assert.equal(response.body.report.svgRasterFailures, 0);
    createdIds.push(response.body.brandingId);

    const branding = await brandings.readBranding(response.body.brandingId);
    assert.deepEqual(branding.colors.map((color) => color.hex), ['#123456', '#FF6633', '#F3F5F7']);
    assert.equal(branding.typography.length, 2);
    assert.equal(branding.typography[0].role, 'heading');
    assert.match(branding.typography[0].file, /^assets\/Test-Font-Regular\.woff$/);
    assert.equal(branding.logos.length, 1);
    assert.match(branding.logos[0].file, /^assets\/logo-primary\.svg$/);
    assert.match(branding.logos[0].usage, /PNG-Vorschau: assets\/logo-primary-preview\.png/);
    assert.deepEqual(branding.imagery.references, ['assets/hero.png']);
    assert.match(branding.guidelines, /Klare Regeln fuer Logo und Farben/);

    const assets = await fsp.readdir(brandings.brandingAssetsDir(branding.id));
    for (const expected of ['Test-Font-Regular.woff', 'logo-primary.svg', 'logo-primary-preview.png', 'hero.png']) {
      assert.ok(assets.includes(expected), `Erwartetes Branding-Asset fehlt: ${expected}`);
    }
    await assert.rejects(fsp.access(escapedTarget), { code: 'ENOENT' });

    const collision = await brandingImport.importBrandingZip({ buffer: testZip, filename: 'claude-design.zip' });
    createdIds.push(collision.brandingId);
    assert.equal(collision.name, 'Claude Import Test (Import)');

    await assert.rejects(
      brandingImport.importBrandingZip({ buffer: Buffer.alloc(brandingImport.MAX_ZIP_BYTES + 1) }),
      /maximal 80 MB gross/
    );
    const tooManyEntries = patchEntryCount(await zipBuffer([]), brandingImport.MAX_ENTRIES + 1);
    await assert.rejects(
      brandingImport.importBrandingZip({ buffer: tooManyEntries }),
      /mehr als 400 Eintraege/
    );
    const oversizedMetadata = patchFirstUncompressedSize(
      await zipBuffer([{ name: 'large.bin', buffer: Buffer.from('klein') }]),
      brandingImport.MAX_UNCOMPRESSED_BYTES + 1
    );
    await assert.rejects(
      brandingImport.importBrandingZip({ buffer: oversizedMetadata }),
      /entpackt groesser als 200 MB/
    );

    console.log('Branding-Import: Heuristik, Assets, SVG-Vorschau, Bericht, Namenskollision und ZIP-Limits sind korrekt.');
  } finally {
    await fsp.rm(escapedTarget, { force: true });
    for (const id of createdIds) await brandings.deleteBranding(id).catch(() => {});
  }
  console.log('test-branding-import.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
