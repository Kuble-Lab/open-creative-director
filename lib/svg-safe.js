'use strict';

// resvg resolves absolute and relative file paths in href / url(), so an uploaded or generated SVG could pull
// other images from the server's disk into the raster. Allowed are in-document references (#id), inline data:
// URIs and http(s) URLs: resvg never fetches remote resources, so web fonts or links in exported logos are
// simply ignored instead of breaking the PNG preview.
function isAllowedTarget(target) {
  return !target || target.startsWith('#') || /^data:/i.test(target) || /^https?:\/\//i.test(target);
}

function assertNoExternalReferences(svg) {
  const text = String(svg);
  for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gis)) {
    if (!isAllowedTarget(match[2].trim())) throw new Error('svg: external references are not allowed');
  }
  for (const match of text.matchAll(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi)) {
    if (!isAllowedTarget(match[2].trim())) throw new Error('svg: external references are not allowed');
  }
  for (const match of text.matchAll(/@import\s+(["'])(.*?)\1/gi)) {
    if (!isAllowedTarget(match[2].trim())) throw new Error('svg: imports and entities are not allowed');
  }
  if (/<!ENTITY/i.test(text)) throw new Error('svg: imports and entities are not allowed');
}

module.exports = { assertNoExternalReferences };
