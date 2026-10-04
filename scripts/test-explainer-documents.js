'use strict';

// Documents in the node view (WP37a): the port type "document", the upload of PDF, TXT and MD files, the node "Document"
// (input.document) and the node "Read documents" (doc.read, lib/documents.js).
//   - the checks of an upload: magic bytes, 50 MB, empty files, binary and non-UTF-8 text, the extensions of the ledger
//   - the upload route of the node view: the value carries name, size and page count; wrong files are refused with 415/413/400
//   - input.document: validation (no file, a file that is gone) and its output as a list
//   - doc.read: page marks (neutral and by language), the info text, "scanned", page images (none / first / all), max_pages with the log,
//     TXT and MD as sections, only PDFs in "files", a document of another session, poppler missing
// A private copy of the app runs in a temp directory. Poppler is used for real; without it the PDF parts are skipped with a note.

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { createIsolatedApp } = require('./support/isolated-app');
const { makePdf } = require('./support/pdf');

const ADMIN = 'admin@example.com';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

async function main() {
  const iso = await createIsolatedApp({ env: { ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: '', GTS_API_TOKEN: '' } });
  await iso.listen();
  assert.notEqual(iso.port, 3111);
  try {
    await run(iso);
  } finally {
    await iso.cleanup();
  }
  console.log('test-explainer-documents.js: ok');
}

async function run(iso) {
  const documents = iso.load('lib/documents');
  const assets = iso.load('lib/nodes/assets');
  const store = iso.load('lib/store');
  const types = iso.load('lib/nodes/types');
  const registryModule = iso.load('lib/nodes/registry');
  const real = registryModule.registry;
  const poppler = documents.binaries().available;
  if (!poppler) console.log('poppler not found: the parts with real PDF files are skipped');

  /* ---------- the checks of a file ---------- */

  const dir = await fsp.mkdtemp(path.join(iso.root, 'documents-'));
  const write = async (name, bytes) => {
    const file = path.join(dir, name);
    await fsp.writeFile(file, bytes);
    return file;
  };
  const pdf2 = makePdf(['First page of the report.\nThe market grew by 42 %.', 'Second page.\nWe checked it twice.'], { title: 'Report' });

  assert.deepEqual([...documents.DOCUMENT_EXTS], ['.pdf', '.txt', '.md']);
  assert.equal(documents.MAX_DOCUMENT_BYTES, 50 * 1024 * 1024);
  assert.equal(documents.typeOfExtension('.pdf'), 'pdf');
  assert.equal(documents.typeOfExtension('.TXT'), 'text');
  assert.equal(documents.typeOfExtension('.md'), 'text');
  assert.equal(documents.typeOfExtension('.docx'), null);

  const checked = await documents.checkDocumentFile(await write('ok.pdf', pdf2), '.pdf');
  assert.equal(checked.bytes, pdf2.length);
  assert.equal((await errorOf(documents.checkDocumentFile(await write('fake.pdf', 'just some text'), '.pdf'))).code, 'UNSUPPORTED_MEDIA', 'a PDF starts with %PDF-');
  assert.equal((await errorOf(documents.checkDocumentFile(await write('png.pdf', Buffer.concat([PNG_MAGIC, Buffer.alloc(40)])), '.pdf'))).code, 'UNSUPPORTED_MEDIA');
  assert.equal((await errorOf(documents.checkDocumentFile(await write('empty.txt', ''), '.txt'))).code, 'INVALID_REQUEST');
  assert.equal((await errorOf(documents.checkDocumentFile(await write('bin.txt', Buffer.from([0x41, 0x00, 0x42])), '.txt'))).code, 'UNSUPPORTED_MEDIA', 'a text file holds no NUL');
  assert.equal((await errorOf(documents.checkDocumentFile(await write('latin.md', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6b])), '.md'))).code, 'UNSUPPORTED_MEDIA', 'a text file is UTF-8');
  await documents.checkDocumentFile(await write('good.md', '# Title\n\nGrüezi, café.'), '.md');
  // 50 MB is allowed, one byte more is not (a sparse file: nothing is really written)
  const big = path.join(dir, 'big.txt');
  await fsp.writeFile(big, 'x'.repeat(70000));
  await fsp.truncate(big, documents.MAX_DOCUMENT_BYTES);
  assert.equal((await documents.checkDocumentFile(big, '.txt')).bytes, documents.MAX_DOCUMENT_BYTES);
  await fsp.truncate(big, documents.MAX_DOCUMENT_BYTES + 1);
  assert.equal((await errorOf(documents.checkDocumentFile(big, '.txt'))).code, 'TOO_LARGE');

  /* ---------- the ledger and the type ---------- */

  assert.equal(assets.typeFromExtension('.pdf'), 'document');
  assert.equal(assets.typeFromExtension('.txt'), 'document');
  assert.equal(assets.typeFromExtension('.md'), 'document');
  assert.equal(assets.typeFromLedgerEntry({ kind: 'upload', file: 'upload-001.pdf' }), 'document');
  assert.equal(assets.typeFromLedgerEntry({ kind: 'upload', file: 'upload-002.md' }), 'document');
  assert.equal(assets.typeFromLedgerEntry({ kind: 'upload', file: 'upload-003.docx' }), null);
  assert.ok(types.PORT_TYPES.document, 'the port type exists');
  assert.equal(types.PORT_TYPES.document.media, true);
  assert.ok(types.canConnect('document', 'document'));
  assert.ok(!types.canConnect('document', 'image'));
  assert.ok(!types.canConnect('image', 'document'));
  assert.ok(types.canConnect('document', 'any'));

  /* ---------- the upload route ---------- */

  const created = await iso.request('/api/workflows', { method: 'POST', as: ADMIN, json: { name: 'Documents' } });
  assert.equal(created.status, 201, created.text);
  const workflowId = created.body.workflow.id;
  const sessionId = created.body.workflow.sessionId;
  const upload = (name, bytes, { type = 'application/octet-stream', query = '' } = {}) =>
    iso.request(`/api/workflows/${workflowId}/uploads${query}`, { method: 'POST', as: ADMIN, body: bytes, headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name) } });

  const upPdf = await upload('Jahresbericht ä.pdf', pdf2, { type: 'application/pdf' });
  assert.equal(upPdf.status, 200, upPdf.text);
  const pdfValue = upPdf.body.value;
  assert.equal(pdfValue.type, 'document');
  assert.equal(pdfValue.name, 'Jahresbericht ä.pdf');
  assert.equal(pdfValue.bytes, pdf2.length);
  assert.match(pdfValue.file, /^upload-\d{3}\.pdf$/);
  if (poppler && documents.binaries().pdfinfo) assert.equal(pdfValue.pages, 2, 'the page count of a PDF');
  const ledger = await store.readLedger(sessionId);
  const entry = ledger.find((item) => item.id === pdfValue.assetId);
  assert.equal(entry.kind, 'upload');
  assert.equal(entry.prompt, 'Jahresbericht ä.pdf');
  assert.equal(entry.bytes, pdf2.length);
  assert.ok((await fsp.readFile(path.join(store.sessionAssetDir(sessionId), pdfValue.file))).equals(pdf2));

  const upTxt = await upload('notes.txt', Buffer.from('Some notes.\nA second line.'), { type: 'text/plain' });
  assert.equal(upTxt.status, 200, upTxt.text);
  assert.equal(upTxt.body.value.type, 'document');
  assert.equal(upTxt.body.value.pages, undefined, 'a text file has no pages');
  const upMd = await upload('readme.md', Buffer.from('# Title\n\nText'), { type: 'text/markdown' });
  assert.equal(upMd.status, 200, upMd.text);
  assert.equal(upMd.body.value.type, 'document');
  // the extension of the name counts when the content type is generic
  assert.equal((await upload('plain.md', Buffer.from('# x'))).body.value.type, 'document');
  // ?accept= keeps a document out of an image port and the other way round
  assert.equal((await upload('a.pdf', pdf2, { type: 'application/pdf', query: '?accept=image' })).status, 415);
  assert.equal((await upload('a.pdf', pdf2, { type: 'application/pdf', query: '?accept=document' })).status, 200);
  assert.equal((await upload('a.png', PNG_MAGIC, { type: 'image/png', query: '?accept=document' })).status, 415);
  // refused: not a PDF, empty, binary, a type that is none of ours
  assert.equal((await upload('fake.pdf', Buffer.from('this is not a pdf'), { type: 'application/pdf' })).status, 415);
  assert.equal((await upload('empty.txt', Buffer.alloc(0), { type: 'text/plain' })).status, 400);
  assert.equal((await upload('bin.txt', Buffer.from([1, 0, 2, 0]), { type: 'text/plain' })).status, 415);
  assert.equal((await upload('letter.docx', Buffer.from('PK'), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).status, 415);
  // the limit: a body above 50 MB is refused (by its declared size, before it is read)
  const tooLarge = await upload('huge.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(documents.MAX_DOCUMENT_BYTES)]), { type: 'application/pdf' });
  assert.equal(tooLarge.status, 413);
  const leftovers = (await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-'));
  assert.deepEqual(leftovers, [], 'no scratch folder is left after the uploads');
  // the duplicate of a workflow keeps name, size and pages
  const copied = await assets.copyAsset(sessionId, pdfValue.assetId, (await store.createSession()).id);
  assert.equal(copied.name, 'Jahresbericht ä.pdf');
  assert.equal(copied.bytes, pdf2.length);

  /* ---------- the node "Document" ---------- */

  const exec = (type, ctx, inputs, raw = {}) => {
    const def = real.get(type);
    return def.execute(ctx, inputs, real.normalizeParams(def, raw));
  };
  const makeCtx = (owner = sessionId) => {
    const logs = [];
    const controller = new AbortController();
    return {
      workflowId: workflowId,
      runId: 'r-test',
      nodeId: 'n1',
      sessionId: owner,
      user: ADMIN,
      config: {},
      signal: controller.signal,
      toolCtx: { nodeView: true, sessionId: owner, config: {}, user: ADMIN, emit() {}, signal: controller.signal },
      log: (line) => logs.push(line),
      saveOutputFile: (options) => assets.saveOutputFile(owner, options),
      withLocalSlot: (fn) => fn(),
      logs
    };
  };
  const asset = async (bytes, ext, name, owner = sessionId) => {
    const saved = await store.saveAsset(owner, { kind: 'upload', buffer: bytes, ext, prompt: name });
    return assets.valueFromAsset(owner, saved.id);
  };

  const inputDef = real.get('input.document');
  assert.equal(inputDef.category, 'input');
  assert.deepEqual(inputDef.outputs.map((port) => [port.id, port.type]), [['documents', 'document[]']]);
  const issues = inputDef.validate(real.normalizeParams(inputDef, {}), {});
  assert.ok(issues.some((issue) => issue.code === 'no_asset'), 'no file: the node says so');
  const pdfAsset = await asset(pdf2, '.pdf', 'report.pdf');
  const txtAsset = await asset(Buffer.from('Alpha beta gamma.\n\nDelta.'), '.txt', 'plain.txt');
  const mdAsset = await asset(Buffer.from('# Heading\n\nSome *markdown*.'), '.md', 'readme.md');
  const params = real.normalizeParams(inputDef, { assets: [pdfAsset, txtAsset] });
  assert.deepEqual(inputDef.validate(params, {}), [], 'two files are fine');
  const listed = (await inputDef.execute(makeCtx(), {}, params)).variants[0].documents;
  assert.equal(listed.type, 'list');
  assert.equal(listed.items.length, 2);
  assert.deepEqual(listed.items.map((item) => item.type), ['document', 'document']);
  assert.equal(listed.items[0].name, 'report.pdf');
  // a file that is gone is reported by the validation (the interface marks it), and a run refuses it
  const gone = real.normalizeParams(inputDef, { assets: [{ ...txtAsset, missing: true }] });
  assert.ok(inputDef.validate(gone, {}).some((issue) => issue.code === 'asset_lost'));
  const lost = real.normalizeParams(inputDef, { assets: [{ ...txtAsset, assetId: 'upload-999', file: 'upload-999.txt' }] });
  assert.match((await errorOf(inputDef.execute(makeCtx(), {}, lost))).message, /^Document 1:/);
  // a picture is no document
  const picture = await asset(PNG_MAGIC, '.png', 'p.png');
  assert.ok(await errorOf(inputDef.execute(makeCtx(), {}, real.normalizeParams(inputDef, { assets: [picture] }))));

  /* ---------- doc.read ---------- */

  const readDef = real.get('doc.read');
  assert.ok(!readDef.paid, 'free of charge');
  assert.equal(readDef.cost.unit, 'local');
  assert.deepEqual(readDef.inputs.map((port) => [port.id, port.type, Boolean(port.required)]), [['documents', 'document[]', true]]);
  assert.deepEqual(readDef.outputs.map((port) => [port.id, port.type]), [['text', 'text'], ['info', 'text'], ['pages', 'image[]'], ['files', 'document[]']]);
  const paramOf = (id) => readDef.params.find((param) => param.id === id);
  assert.equal(paramOf('max_pages').default, 150);
  assert.equal(paramOf('max_pages').max, 300);
  assert.deepEqual(paramOf('page_images').options, ['none', 'first', 'all']);
  assert.equal(paramOf('page_images').default, 'none');
  assert.equal(readDef.available(), poppler ? true : documents.MISSING_POPPLER);

  const read = async (values, raw = {}, ctx = makeCtx()) => {
    const out = (await exec('doc.read', ctx, { documents: types.listValue('document', values) }, raw)).variants[0];
    return { out, ctx, text: out.text.value, info: JSON.parse(out.info.value) };
  };

  // text and markdown need no poppler
  {
    const { text, info, out } = await read([txtAsset, mdAsset]);
    assert.match(text, /^=== D1: plain\.txt \(1 page\) ===\n\[p\. 1\]\nAlpha beta gamma\./);
    assert.match(text, /=== D2: readme\.md \(1 page\) ===\n\[p\. 1\]\n# Heading/);
    assert.equal(info.documents.length, 2);
    assert.equal(info.documents[0].type, 'text');
    assert.equal(info.documents[0].pages_are_sections, true, 'sections stand for pages and the info says so');
    assert.equal(info.documents[0].scanned, false, 'only a PDF can be scanned');
    assert.equal(out.files.items.length, 0, 'files holds the PDFs only');
    assert.equal(out.pages.items.length, 0);
    // long text is cut into sections, which carry the marks
    const long = await asset(Buffer.from(Array.from({ length: 60 }, (_x, i) => `Paragraph ${i + 1}: ${'word '.repeat(40)}`).join('\n\n')), '.txt', 'long.txt');
    const sections = await read([long], { language: 'de' });
    assert.ok(sections.info.documents[0].pages > 1);
    assert.match(sections.text, /\[Seite 1\][\s\S]*\[Seite 2\]/);
    assert.ok(!/\[p\. 1\]/.test(sections.text));
    // the limit
    const capped = await read([long], { max_pages: 1 });
    assert.equal(capped.info.documents[0].pages_read, 1);
    assert.equal(capped.info.documents[0].truncated, true);
    assert.ok(capped.ctx.logs.some((line) => /only the first 1 read/.test(line)), capped.ctx.logs.join('|'));
    assert.ok(!/\[p\. 2\]/.test(capped.text));
  }

  // another session's file is refused
  {
    const other = (await store.createSession()).id;
    const foreign = await asset(Buffer.from('x y z'), '.txt', 'x.txt', other);
    const err = await errorOf(exec('doc.read', makeCtx(), { documents: types.listValue('document', [foreign]) }));
    assert.match(err.message, /belongs to another session/);
  }

  if (poppler) {
    // page marks, the info text, title and counts
    {
      const { text, info, out } = await read([pdfAsset]);
      assert.match(text, /^=== D1: report\.pdf \(2 pages\) ===\n\[p\. 1\]\nFirst page of the report\.\nThe market grew by 42 %\.\n\[p\. 2\]\nSecond page\./);
      assert.equal(info.documents[0].type, 'pdf');
      assert.equal(info.documents[0].pages, 2);
      assert.equal(info.documents[0].pages_read, 2);
      assert.equal(info.documents[0].chars_per_page.length, 2);
      assert.equal(info.documents[0].scanned, true, 'two short pages are under 200 characters a page');
      assert.equal(info.total_pages, 2);
      assert.equal(info.max_pages, 150);
      assert.equal(out.files.items.length, 1);
      assert.equal(out.files.items[0].assetId, pdfAsset.assetId, 'the PDF passes through unchanged');
      assert.equal(out.pages.items.length, 0, 'no page images unless asked');
    }
    // the marks follow the language
    assert.match((await read([pdfAsset], { language: 'de' })).text, /\[Seite 1\][\s\S]*\[Seite 2\]/);
    assert.match((await read([pdfAsset], { language: 'en' })).text, /\[Page 2\]/);
    assert.match((await read([pdfAsset], { language: 'es' })).text, /\[Página 2\]/);
    // a PDF with a lot of text is not scanned; one without text is, and the log says so
    {
      const fat = await asset(makePdf([Array(12).fill('The quick brown fox jumps over the lazy dog.').join('\n'), Array(12).fill('Pack my box with five dozen liquor jugs.').join('\n')]), '.pdf', 'fat.pdf');
      const result = await read([fat]);
      assert.equal(result.info.documents[0].scanned, false);
      assert.ok(result.info.documents[0].chars_per_page.every((count) => count > 200));
      const blank = await asset(makePdf(['', '', '']), '.pdf', 'scan.pdf');
      const scan = await read([blank]);
      assert.equal(scan.info.documents[0].scanned, true);
      assert.equal(scan.info.scanned, true);
      assert.equal(scan.info.documents[0].pages, 3);
      assert.match(scan.text, /\(no text on this page\)/);
      assert.ok(scan.ctx.logs.some((line) => /looks scanned/.test(line)), scan.ctx.logs.join('|'));
    }
    // the page images: first three pages, or all pages read, as 150 dpi PNG files in the session
    {
      const five = await asset(makePdf(['one', 'two', 'three', 'four', 'five']), '.pdf', 'five.pdf');
      const first = await read([five], { page_images: 'first' });
      assert.equal(first.out.pages.items.length, 3);
      assert.equal(first.out.pages.type, 'list');
      const all = await read([five], { page_images: 'all' });
      assert.equal(all.out.pages.items.length, 5);
      const bytes = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), all.out.pages.items[0].file));
      assert.ok(bytes.subarray(0, 4).equals(PNG_MAGIC), 'a PNG');
      // 612 x 792 pt at 150 dpi = 1275 x 1650 px
      assert.equal(bytes.readUInt32BE(16), 1275);
      assert.equal(bytes.readUInt32BE(20), 1650);
      assert.equal(all.out.pages.items[0].type, 'image');
      const ledger2 = await store.readLedger(sessionId);
      assert.match(ledger2.find((item) => item.id === all.out.pages.items[4].assetId).prompt, /five\.pdf p\. 5/);
      const none = await read([five], { page_images: 'none' });
      assert.equal(none.out.pages.items.length, 0);
      // the info says where the images of each document are: the list holds them one document after the other
      assert.deepEqual([all.info.documents[0].images, all.info.documents[0].image_offset, all.info.page_images], [5, 0, 'all']);
      assert.deepEqual([first.info.documents[0].images, first.info.page_images], [3, 'first']);
      assert.deepEqual([none.info.documents[0].images, none.info.documents[0].image_offset], [0, null], 'no images: no place in the list');
      const pair = await read([five, pdfAsset], { page_images: 'all' });
      assert.equal(pair.info.documents[0].image_offset, 0);
      assert.equal(pair.info.documents[1].image_offset, pair.info.documents[0].images, 'the images of the second PDF follow those of the first');
      assert.equal(pair.out.pages.items.length, pair.info.documents[0].images + pair.info.documents[1].images);
      const mixed = await read([txtAsset, five], { page_images: 'all' });
      assert.deepEqual([mixed.info.documents[0].images, mixed.info.documents[0].image_offset], [0, null], 'a text file has none');
      assert.deepEqual([mixed.info.documents[1].images, mixed.info.documents[1].image_offset], [5, 0]);
      // a text file has no page images; the log says why there are none
      const noPdf = await read([txtAsset], { page_images: 'first' });
      assert.equal(noPdf.out.pages.items.length, 0);
      assert.ok(noPdf.ctx.logs.some((line) => /need a PDF/.test(line)));
      // max_pages cuts the text and the images alike, and is a budget across the documents
      const cut = await read([five, pdfAsset], { max_pages: 3, page_images: 'all' });
      assert.equal(cut.info.documents[0].pages_read, 3);
      assert.equal(cut.info.documents[0].truncated, true);
      assert.equal(cut.info.documents[1].pages_read, 0, 'the budget is used up by the first document');
      assert.equal(cut.out.pages.items.length, 3);
      assert.ok(cut.ctx.logs.some((line) => /only the first 3 read/.test(line)), cut.ctx.logs.join('|'));
      assert.ok(!/\[p\. 4\]/.test(cut.text));
      assert.equal(cut.out.files.items.length, 2, 'files lists every PDF, read or not');
      // no scratch folder is left behind
      assert.deepEqual((await fsp.readdir(store.sessionAssetDir(sessionId))).filter((name) => name.startsWith('.nodes-')), []);
    }
    // a damaged PDF: a named error, not a stack
    {
      const broken = await asset(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('garbage that is no pdf at all')]), '.pdf', 'broken.pdf');
      const err = await errorOf(exec('doc.read', makeCtx(), { documents: types.listValue('document', [broken]) }));
      assert.ok(err && /broken\.pdf/.test(err.message), err && err.message);
      assert.equal(err.code, 'DOCUMENT_UNREADABLE');
    }
    // a file that is gone from the disk: the message names the file, never the folder on the server
    {
      const missingFile = path.join(dir, 'server-folder', 'secret-session', 'gone.pdf');
      const err = await errorOf(documents.readDocument(missingFile, { ext: '.pdf', name: 'gone.pdf' }));
      assert.equal(err && err.code, 'DOCUMENT_UNREADABLE');
      assert.match(err.message, /gone\.pdf/);
      assert.ok(!err.message.includes('secret-session') && !err.message.includes(dir), err.message);
      assert.ok(!String(err.detail).includes('secret-session'));
    }
  }

  // poppler missing: the node says so before it runs, and a run refuses the PDF with the same words
  {
    const previous = process.env.POPPLER_BIN_DIR;
    process.env.POPPLER_BIN_DIR = path.join(dir, 'no-such-folder');
    try {
      assert.equal(documents.binaries().available, false);
      assert.equal(readDef.available(), 'pdftotext/pdftoppm not found (poppler)');
      assert.equal(documents.available(), documents.MISSING_POPPLER);
      const err = await errorOf(exec('doc.read', makeCtx(), { documents: types.listValue('document', [pdfAsset]) }));
      assert.equal(err.code, 'POPPLER_MISSING');
      assert.match(err.message, /poppler/);
      // text files do not need it
      const ok = await exec('doc.read', makeCtx(), { documents: types.listValue('document', [txtAsset]) });
      assert.match(ok.variants[0].text.value, /Alpha beta gamma/);
    } finally {
      if (previous === undefined) delete process.env.POPPLER_BIN_DIR;
      else process.env.POPPLER_BIN_DIR = previous;
    }
  }

  // the registry says so for the interface
  const availability = registryModule.registry.availability(readDef);
  assert.equal(availability, poppler ? true : 'pdftotext/pdftoppm not found (poppler)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
