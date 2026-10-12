'use strict';

const fs = require('fs/promises');
const composition = require('./composition');
const view = require('./view');
const { checkGraphics } = require('./contract');
const { textFields, validateTextOverrides, applyTextOverrides } = require('./text-overrides');

const error = (code, message) => Object.assign(new Error(message), { code });
const unavailable = (message) => error('CARD_PREVIEW_UNAVAILABLE', message);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// Older/custom plans may omit the card; validate the remaining contract with a temporary card.
const withCard = (graphics) => graphics && graphics.endcard == null ? { ...graphics, endcard: { line: 'Preview', sub: null, url: null, seconds: 2, logo: false } } : graphics;
const selected = (results, id) => {
  const result = results?.nodes?.[id];
  return result?.history?.find((entry) => entry.id === result.selected?.entry)?.variants?.[result.selected?.variant || 0];
};

function previewSource(workflow, results, nodeId) {
  const node = workflow.graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw error('NOT_FOUND', 'Node not found');
  if (node.type !== 'event_video.render') throw unavailable('Card previews require an event video render node');
  const edge = workflow.graph.edges.find((item) => item.to.node === nodeId && item.to.port === 'graphics');
  const planner = workflow.graph.nodes.find((item) => item.id === edge?.from.node);
  if (planner?.type !== 'event_video.plan' || edge.from.port !== 'graphics') throw unavailable('Connect an event video plan first');
  const variant = selected(results, planner.id);
  let graphics;
  try { graphics = JSON.parse(variant?.graphics?.value); }
  catch (_) { throw unavailable('Select an event video plan first'); }
  if (!checkGraphics(withCard(graphics)).ok) throw unavailable('The selected event video plan is invalid');
  let plan = results.nodes[planner.id].selected.entry;
  try { plan = JSON.parse(variant.ai_switches?.value)?.base || plan; } catch (_) { /* older plans have no switch identity */ }
  return { node, graphics, plan };
}

function correctedGraphics(graphics, raw, plan) {
  if (raw === undefined || raw === '') return graphics;
  const invalid = (message) => error('EVENTRENDER_TEXT_INVALID', message);
  if (typeof raw !== 'string') throw invalid('text_overrides must be a JSON string');
  const issues = validateTextOverrides(raw);
  if (issues.length) throw invalid(issues[0].message);
  const patch = JSON.parse(raw);
  if ((plan && patch.plan && plan !== patch.plan) || patch.base !== JSON.stringify(textFields(graphics).map(({ path, value }) => [path, value]))) {
    throw unavailable('The plan changed; reopen the text corrections');
  }
  try {
    if (graphics.endcard) return applyTextOverrides(graphics, raw);
    const complete = withCard(graphics);
    const adjusted = JSON.stringify({ ...patch, base: JSON.stringify(textFields(complete).map(({ path, value }) => [path, value])) });
    return { ...applyTextOverrides(complete, adjusted), endcard: graphics.endcard };
  } catch (err) { throw invalid(err.message); }
}

// Resolve only local, already available input values; never execute an upstream node or fetch a URL.
async function logoDataUrl(workflow, results, node, graphics, assets, sessions) {
  if (!graphics.endcard?.logo) return null;
  const edge = workflow.graph.edges.find((item) => item.to.node === node.id && item.to.port === 'logo');
  if (!edge) return null;
  const source = workflow.graph.nodes.find((item) => item.id === edge.from.node);
  let value = selected(results, source?.id)?.[edge.from.port];
  try {
    if (!value && source?.type === 'input.image' && source.params?.asset) {
      const ref = assets.assetRefFromParam(source.params.asset, workflow.sessionId);
      if (!ref || ref.sessionId !== workflow.sessionId) throw new Error('Logo belongs to another workflow');
      const ledger = await sessions.readLedger(workflow.sessionId);
      value = assets.valueFromLedgerEntry(workflow.sessionId, ledger.find((entry) => entry.id === ref.assetId));
    }
    if (!value?.assetId || value.sessionId !== workflow.sessionId || value.type !== 'image') return null;
    // SVG uploads already have a raster companion. Embed only recognised raster bytes, never SVG/HTML or a URL.
    const file = assets.assetFilePath(value);
    const info = await fs.stat(file);
    if (info.size > 10 * 1024 * 1024) throw new Error('Logo exceeds 10 MB');
    const bytes = await fs.readFile(file);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
          : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new Error('Logo is not a supported raster image');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch (_) { throw unavailable('The connected logo cannot be previewed; check the logo input'); }
}

// The fonts and the logo go once with an answer, not once per document (six documents, fonts of up to ~700 KB): each
// document holds these slots, and the client puts answer.fonts and answer.logo into them before it shows a document.
const SLOTS = Object.freeze({ fonts: '/*ocd-card-fonts*/', logo: 'ocd-card-logo' });

function buildPreviews(graphics, logo = null) {
  if (!checkGraphics(withCard(graphics)).ok) throw unavailable('The selected event video plan is invalid');
  if (logo !== null && !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo)) throw unavailable('Invalid preview logo');
  const fonts = composition.fontFaces(composition.fontFamilies(graphics));
  const previews = ['16:9', '1:1', '9:16'].map((format) => {
    const documents = {};
    const chunk = { start: 0, duration: graphics.duration };
    const data = composition.pageData({ graphics, format, chunk, logoFile: logo ? SLOTS.logo : null });
    for (const section of ['title', 'endcard']) {
      if (!data[section]) continue;
      // Hold even a very short title after its entrance, without changing any measured layout data.
      let t = data.endcard ? data.endcard.start + 1.1 : 0;
      let held = data;
      if (section === 'title') {
        const title = data.title;
        const count = title.anim === 'words_up' ? title.lines.join(' ').split(' ').length : [...title.lines.join('')].length;
        const entrance = title.anim === 'words_up' ? data.look.titleSeconds + (count - 1) * 0.06
          : title.anim === 'char_slam' ? data.look.titleSeconds * 0.6 + (count - 1) * 0.02 : data.look.titleSeconds;
        t = title.start + Math.max(entrance, data.look.titleSeconds * 0.5 + 0.4) + 0.01;
        held = { ...data, title: { ...title, end: Math.max(title.end, t + view.OUT_SECONDS + 0.01) } };
      }
      const frame = view.render(held, t);
      const content = section === 'title' ? frame.title : `<div id="e-veil" class="veil" style="${esc(frame.endVeil)}"></div><div class="ecard">${data.endcard.logo ? `<img class="elogo" src="${SLOTS.logo}" alt="" style="${esc(frame.endLogo)}">` : ''}<div id="l-end">${frame.end}</div></div>`;
      documents[section] = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'"><style>${SLOTS.fonts}\n${composition.STYLE}\nhtml,body{width:100%;height:100%}svg{display:block;width:100%;height:100%}#main-composition{background:#111214}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${data.width} ${data.height}"><foreignObject width="${data.width}" height="${data.height}"><div xmlns="http://www.w3.org/1999/xhtml" id="main-composition" style="width:${data.width}px;height:${data.height}px"><div id="l-tint" class="layer" style="${esc(composition.tintStyle(data.look.tint))}"></div><div id="l-glow" class="layer" style="${esc(frame.glow)}"></div>${content}</div></foreignObject></svg></body></html>`;
    }
    return { format, width: data.width, height: data.height, ...documents };
  });
  return { slots: SLOTS, fonts, logo, previews };
}

module.exports = { previewSource, correctedGraphics, logoDataUrl, buildPreviews };
