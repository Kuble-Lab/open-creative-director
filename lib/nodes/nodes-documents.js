'use strict';

// Document nodes (WP37a): "Read documents" turns uploaded PDF, TXT and MD files into text with page marks, an info text, the page images
// (optional) and the PDFs themselves for a model that reads files. It runs on this machine and costs nothing. The work is done by
// lib/documents.js (poppler for PDF); this module is the adapter between it and the engine.
//   doc.read   documents -> text, info, pages, files
//   info: { documents: [{ index, name, type, title, pages, pages_read, chars, chars_per_page, scanned, truncated, bytes }],
//           total_pages, total_chars, scanned, max_pages }   (scanned: fewer than 200 characters per page on average)

const path = require('path');

const documentsLib = require('../documents');
const assets = require('./assets');
const { textValue, listValue } = require('./types');

const PAGE_IMAGE_DPI = 150;
const FIRST_PAGES = 3;
// a list the next node takes holds at most this many entries (the engine's limit for a list on a single input)
const ENGINE_LIST_LIMIT = 50;

function itemsOf(inputs, portId) {
  const value = inputs[portId];
  if (!value) return [];
  return value.type === 'list' ? value.items : [value];
}

const readDefinition = {
  type: 'doc.read',
  category: 'text',
  label: 'Read documents',
  keywords: ['document', 'documents', 'pdf', 'read', 'text', 'extract', 'pages', 'ocr', 'scan', 'markdown', 'poppler'],
  description:
    'Reads PDF, TXT and MD files on this machine, free of charge: the text with a mark before every page ([p. 3]), an info text (pages, ' +
    'characters per page, "scanned" when a document has almost no text), the page images (optional) and the PDFs for a model that reads files.',
  inputs: [{ id: 'documents', type: 'document[]', required: true, suggest: 'input.document' }],
  outputs: [
    { id: 'text', type: 'text' },
    { id: 'info', type: 'text' },
    { id: 'pages', type: 'image[]' },
    { id: 'files', type: 'document[]' }
  ],
  params: [
    { id: 'max_pages', kind: 'integer', min: 1, max: documentsLib.MAX_PAGES_CEILING, default: documentsLib.DEFAULT_MAX_PAGES },
    { id: 'page_images', kind: 'select', options: ['none', 'first', 'all'], default: 'none' },
    { id: 'language', kind: 'select', options: ['neutral', 'de', 'en', 'es'], default: 'neutral' }
  ],
  cost: { unit: 'local' },
  available: () => documentsLib.available(),
  execute: async (ctx, inputs, params) => {
    const values = itemsOf(inputs, 'documents');
    if (!values.length) throw new Error('No document was given');
    for (const value of values) {
      if (value.sessionId !== ctx.sessionId) throw new Error(`Asset ${value.assetId} belongs to another session`);
    }
    const language = params.language === 'neutral' ? '' : params.language;
    let budget = params.max_pages;
    const read = [];
    const info = [];
    for (const [index, value] of values.entries()) {
      const file = assets.assetFilePath(value);
      const name = value.name || value.file;
      const ext = path.extname(value.file).toLowerCase();
      let doc;
      if (budget <= 0) {
        // the pages are used up by the documents before: this one is listed, not read
        doc = { type: documentsLib.typeOfExtension(ext), title: String(name).replace(/\.[A-Za-z0-9]{1,5}$/, ''), pageCount: value.pages || 0, pages: [], truncated: true, sectionsAsPages: false, chars: 0 };
      } else {
        try {
          doc = await ctx.withLocalSlot(() => documentsLib.readDocument(file, { ext, name, maxPages: budget, signal: ctx.signal }));
        } catch (err) {
          if (err.code === 'DOCUMENT_ENCRYPTED') throw Object.assign(new Error(`${name} is password protected; remove the protection and upload it again`), { code: 'DOCUMENT_ENCRYPTED', data: { name } });
          if (err.code === 'POPPLER_MISSING') throw err;
          if (err.code === 'DOCUMENT_TIMEOUT') throw Object.assign(new Error(`${name} took too long to read`), { code: 'DOCUMENT_TIMEOUT', data: { name } });
          if (err.code === 'DOCUMENT_UNREADABLE') throw Object.assign(new Error(`${name} could not be read (${err.detail || 'damaged or not a valid PDF'})`), { code: 'DOCUMENT_UNREADABLE', data: { name } });
          throw err;
        }
        budget -= doc.pages.length;
      }
      if (doc.truncated) ctx.log(`${name}: ${doc.pageCount} ${doc.sectionsAsPages ? 'sections' : 'pages'}, only the first ${doc.pages.length} read (max_pages ${params.max_pages})`);
      const chars = doc.pages.map((page) => page.text.replace(/\s+/g, ' ').trim().length);
      const scanned = doc.type === 'pdf' && doc.pages.length > 0 && documentsLib.looksScanned(doc.pages);
      if (scanned) ctx.log(`${name} looks scanned (about ${Math.round(chars.reduce((a, b) => a + b, 0) / chars.length)} characters per page): the text is nearly empty. A model that reads files still sees the pages.`);
      read.push({ name, value, ext, doc });
      info.push({
        index,
        name,
        type: doc.type,
        title: doc.title,
        pages: doc.pageCount,
        pages_read: doc.pages.length,
        chars: doc.chars,
        chars_per_page: chars,
        scanned,
        truncated: doc.truncated,
        ...(doc.sectionsAsPages ? { pages_are_sections: true } : {}),
        ...(Number.isFinite(value.bytes) ? { bytes: value.bytes } : {})
      });
    }

    // the page images: 150 dpi PNG, from the first pages or from all that were read
    const images = [];
    if (params.page_images !== 'none') {
      const pdfs = read.filter((entry) => entry.doc.type === 'pdf' && entry.doc.pages.length);
      if (!pdfs.length) ctx.log('Page images need a PDF: there is none among the documents');
      const scratch = await assets.createScratchDir(ctx.sessionId);
      try {
        for (const entry of pdfs) {
          const last = params.page_images === 'first' ? Math.min(FIRST_PAGES, entry.doc.pages.length) : entry.doc.pages.length;
          const dir = path.join(scratch, `d${images.length}-${entry.value.assetId}`);
          const rendered = await ctx.withLocalSlot(() => documentsLib.renderPages(assets.assetFilePath(entry.value), dir, { first: 1, last, dpi: PAGE_IMAGE_DPI, signal: ctx.signal }));
          for (const page of rendered) {
            images.push(
              await ctx.saveOutputFile({ kind: 'image', ext: '.png', sourceFile: page.file, prompt: `${entry.name} p. ${page.n}`, cost: 0 })
            );
          }
        }
      } finally {
        await assets.removeScratchDir(scratch);
      }
      if (images.length > ENGINE_LIST_LIMIT) ctx.log(`${images.length} page images: a list on a single input takes at most ${ENGINE_LIST_LIMIT}; choose "first pages" or a lower max_pages for a node that reads one image per run`);
    }

    const text = documentsLib.textWithMarks(
      read.map((entry) => ({ name: entry.name, title: entry.doc.title, pageCount: entry.doc.pageCount, pages: entry.doc.pages, truncated: entry.doc.truncated })),
      { language }
    );
    const totalPages = info.reduce((sum, item) => sum + (item.pages || 0), 0);
    const payload = {
      documents: info,
      total_pages: totalPages,
      total_chars: info.reduce((sum, item) => sum + item.chars, 0),
      scanned: info.some((item) => item.scanned),
      max_pages: params.max_pages
    };
    ctx.log(`${values.length} ${values.length === 1 ? 'document' : 'documents'}, ${totalPages} pages, ${payload.total_chars} characters${payload.scanned ? ', scanned' : ''}`);
    const pdfFiles = read.filter((entry) => entry.doc.type === 'pdf').map((entry) => entry.value);
    return {
      variants: [
        {
          text: textValue(text),
          info: textValue(JSON.stringify(payload, null, 2)),
          pages: listValue('image', images),
          files: listValue('document', pdfFiles)
        }
      ]
    };
  }
};

const definitions = [readDefinition];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = { definitions, registerAll };
