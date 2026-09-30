'use strict';

// Shared checks for motion-graphics HTML: does a text look like HTML at all, and does its composition root
// carry the data-width / data-height of the chosen format? Pure module (no DOM, no I/O), used by the server
// (lib/tools.js render_motion_graphics, lib/nodes/nodes-generate.js validation) and by the node view
// (graph.js conversion of a free-text instruction into a Motion HTML writer).
// UMD: module.exports in Node, window.OCDNodes.motionHtml in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.motionHtml = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Output formats of the render node: [width, height] in pixels.
  const FORMATS = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };

  // Tag names that make a text count as HTML. Deliberately a list (not "anything in angle brackets"), so that
  // prose like "if x<y and z>w" is not mistaken for markup. SVG filter primitives (fe*) and custom elements
  // (a hyphen in the name) are accepted by rule, any other element counts when it is also closed again.
  const KNOWN_TAGS = new Set(
    (
      'html head body div span p a img video audio source track canvas svg path g circle rect line text tspan defs use ' +
      'style script link meta title base noscript h1 h2 h3 h4 h5 h6 ul ol li dl dt dd br hr b i u s em strong small sub sup ' +
      'mark code pre kbd samp blockquote q cite abbr time section article aside header footer main nav figure figcaption ' +
      'button input label select option textarea form fieldset legend table thead tbody tfoot tr td th caption colgroup col ' +
      'iframe picture template slot details summary dialog center font ' +
      'lineargradient radialgradient stop clippath mask filter pattern polygon polyline ellipse image foreignobject symbol ' +
      'marker animate animatetransform animatemotion set textpath desc metadata switch view'
    ).split(' ')
  );

  const DOCTYPE = /<!doctype\s+html/i;
  const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)(?:\s[^<>]*)?\/?>/g;

  // true when the text contains at least one HTML tag of the form <name ...>.
  function looksLikeHtml(text) {
    const value = String(text === undefined || text === null ? '' : text);
    if (DOCTYPE.test(value)) return true;
    for (const match of value.matchAll(OPEN_TAG)) {
      const name = match[1].toLowerCase();
      if (KNOWN_TAGS.has(name) || /^fe[a-z]+$/.test(name) || name.includes('-')) return true;
      // Any other element counts when it is also closed again: <foo>...</foo>.
      if (new RegExp(`</${name.replace(/[^a-z0-9:-]/g, '')}\\s*>`, 'i').test(value)) return true;
    }
    return false;
  }

  // The first data-width / data-height of the text as strings (undefined when missing).
  function declaredSize(html) {
    const value = String(html === undefined || html === null ? '' : html);
    return {
      width: value.match(/data-width\s*=\s*["'](\d+)["']/)?.[1],
      height: value.match(/data-height\s*=\s*["'](\d+)["']/)?.[1]
    };
  }

  // Width and height of a format ('landscape' when unknown or empty).
  function formatSize(format) {
    const key = Object.prototype.hasOwnProperty.call(FORMATS, format) ? format : 'landscape';
    return { format: key, width: FORMATS[key][0], height: FORMATS[key][1] };
  }

  // Checks a composition text against a format. Returns null when it is fine, else
  //   { code: 'not_html',         format, width, height }
  //   { code: 'composition_size', format, width, height, foundWidth, foundHeight }   (found* are strings or null)
  // width / height are the expected numbers of the format.
  function checkComposition(html, format) {
    const expected = formatSize(format);
    if (!looksLikeHtml(html)) return { code: 'not_html', ...expected };
    const found = declaredSize(html);
    if (found.width !== String(expected.width) || found.height !== String(expected.height)) {
      return { code: 'composition_size', ...expected, foundWidth: found.width || null, foundHeight: found.height || null };
    }
    return null;
  }

  return { FORMATS, looksLikeHtml, declaredSize, formatSize, checkComposition };
});
