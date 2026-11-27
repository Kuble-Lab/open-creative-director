'use strict';

// Chat: an uploaded PDF gives the Director its text (lib/brain.js pdfUploadNote), and a refused edit_workflow names its
// reason (lib/tools.js workflowToolError), so the Director can correct it (case of 2026-11-27: three times "ungültig" without a reason).
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const brain = require('../lib/brain');
const tools = require('../lib/tools');
const documents = require('../lib/documents');

// A one-page PDF with a text layer, written by hand (offsets computed).
function tinyPdf(lines) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${[].concat(lines).map((line) => `(${line}) Tj T*`).join(' ')} ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function main() {
  const err = tools.workflowToolError(Object.assign(new Error('Operation 3 (add_node): image.composer has no param "short_edge". Params: format, width, height.'), { code: 'INVALID_EDIT' }));
  assert.match(err.message, /nichts wurde geändert/);
  assert.match(err.message, /Operation 3 \(add_node\): image\.composer has no param "short_edge"/, 'the reason goes along');
  assert.match(tools.workflowToolError({ code: 'INVALID_EDIT' }).message, /Grund: unbekannt/);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-chat-'));
  try {
    const up = { asset: { id: 'upload-001', file: 'upload-001.pdf' }, name: 'Markenhandbuch.pdf' };
    const missing = await brain.pdfUploadNote('s', up, path.join(dir, 'nothing.pdf'));
    assert.match(missing.note, /^Hochgeladenes PDF gespeichert als Asset upload-001 \(Markenhandbuch\.pdf\)/);
    assert.match(missing.note, /konnte nicht gelesen werden/);
    assert.equal(missing.content, undefined);
    if (documents.available()) {
      const file = path.join(dir, 'upload-001.pdf');
      await fsp.writeFile(file, tinyPdf(Array(8).fill('Die Hausfarbe ist WALA Rot und die Schrift heisst Rotis.')));
      const read = await brain.pdfUploadNote('s', up, file);
      assert.match(read.note, /Sein Text steht unten/);
      assert.ok(read.content.startsWith(`${brain.PDF_PART_PREFIX}upload-001: Markenhandbuch.pdf]`), 'the chat view hides this part by its prefix');
      assert.match(read.content, /Hausfarbe ist WALA Rot/);
      assert.match(read.content, /\[Seite 1\]/);
      // a page with almost no text counts as a scan: no content, a note instead
      await fsp.writeFile(file, tinyPdf('x'));
      const scan = await brain.pdfUploadNote('s', up, file);
      assert.match(scan.note, /gescannt/);
      assert.equal(scan.content, undefined);
    } else {
      console.log('   skipped the PDF read: poppler is not installed');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  // the chat view: a "[PDF-Inhalt" part stays out of the bubble, the upload filter takes PDFs
  const messages = await fsp.readFile(path.join(__dirname, '..', 'public', 'app-messages.js'), 'utf8');
  assert.ok(messages.includes("startsWith('[PDF-Inhalt ')"));
  assert.equal(brain.PDF_PART_PREFIX, '[PDF-Inhalt ');
  const transport = await fsp.readFile(path.join(__dirname, '..', 'public', 'app-transport.js'), 'utf8');
  assert.match(transport, /mime === 'application\/pdf'/);
  console.log('test-chat-pdf-and-edit-errors.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
