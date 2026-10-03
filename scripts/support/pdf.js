'use strict';

// Test support (not a test): small PDF files made from bytes, so the document tests need no fixtures.
//
//   makePdf(['first page text', 'second page text'])    a PDF with one page per entry (text in Helvetica, wrapped by lines)
//   makePdf(['', ''])                                     pages without any text: what a scan looks like to pdftotext
//   makePdf(pages, { title: 'Title' })                     with a document title
//
// The file has a correct cross-reference table, so poppler reads it without repairs.

function escapeText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Latin-1 only (WinAnsi): "ü" and "é" work, anything else is replaced.
function latin1(text) {
  return [...String(text)].map((char) => (char.charCodeAt(0) < 256 ? char : '?')).join('');
}

function pageStream(text) {
  const lines = String(text).split('\n');
  if (!lines.join('').trim()) return '';
  const operations = ['BT', '/F1 12 Tf', '14 TL', '56 760 Td'];
  for (const line of lines) operations.push(`(${escapeText(latin1(line))}) Tj`, 'T*');
  operations.push('ET');
  return operations.join('\n');
}

function makePdf(pages, { title = '' } = {}) {
  const list = pages.length ? pages : [''];
  // objects: 1 catalog, 2 pages, 3 font, 4 info, then a page and its content stream per page
  const objects = [];
  const pageIds = list.map((_text, index) => 5 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${list.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = title ? `<< /Title (${escapeText(latin1(title))}) >>` : '<< >>';
  list.forEach((text, index) => {
    const pageId = pageIds[index];
    const stream = pageStream(text);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { makePdf };
