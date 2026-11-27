'use strict';

// Chat cards: a stored file that is no picture (font, PDF from an upload or a branding import) gets a file card with its
// name instead of a broken <img> (case of 2026-11-27: "Branding-Import: upload-008.ttf" showed as a broken image).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener() {}
}

const context = {
  document: { createElement: (tag) => new El(tag) },
  rel: (url) => url,
  t: (key) => key,
  state: {},
  openLightbox() {},
  console
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app-cards.js'), 'utf8'), context);
const card = (asset) => vm.runInContext(`mediaCard(${JSON.stringify(asset)})`, context);
const first = (node) => node.children[0];

const font = card({ id: 'upload-012', kind: 'upload', file: 'upload-012.ttf', url: '/assets/s/upload-012.ttf', prompt: 'Branding-Import: upload-008.ttf aus mwz2t32v-f07045' });
assert.equal(first(font).tagName, 'a', 'a font is a link, not an image');
assert.match(first(font).textContent, /🔤 upload-008\.ttf/);
assert.equal(first(font).download, 'upload-008.ttf');

const pdf = card({ id: 'upload-001', kind: 'upload', url: '/assets/s/upload-001.pdf', prompt: 'Upload: Markenhandbuch.pdf' });
assert.match(first(pdf).textContent, /📕 Markenhandbuch\.pdf/);

assert.equal(first(card({ id: 'img-002', kind: 'image', url: '/assets/s/img-002.png' })).tagName, 'img');
assert.equal(first(card({ id: 'upload-003', kind: 'upload', url: '/assets/s/upload-003.jpg?w=640' })).tagName, 'img', 'a query does not hide the extension');
assert.equal(first(card({ id: 'x', kind: 'upload', url: '/assets/s/x' })).tagName, 'img', 'no extension: as before');
assert.equal(first(card({ id: 'upload-004', kind: 'upload', url: '/assets/s/upload-004.mp3' })).tagName, 'audio');
assert.equal(first(card({ id: 'upload-005', kind: 'upload', url: '/assets/s/upload-005.mp4' })).tagName, 'video');
console.log('test-chat-file-card.js: ok');
