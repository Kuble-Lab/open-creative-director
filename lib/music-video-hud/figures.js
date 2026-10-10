'use strict';

// The figures that come with the app (WP50): official reference images of a figure, for the character sheet of the HUD music video. One figure so far,
// Claudia by anabology (claudia.gallery, an open character; the terms and the source of every image are in figures/claudia/README.md).
//
// Why: the templates describe Claudia with the canon text of claudia.gallery, word for word. Her official images were made with Midjourney, where the text is
// enough; Nano Banana makes another (an older, harder) woman from the same text. With her official images as references the sheet shows her.
//
//   figureOf(figure)     the figure of the app that a parsed figure text (plan.js parseFigure) names, or null: the canon text of Claudia, or a figure named
//                        Claudia that still has her bob and her clay-orange streak. Any other figure (another name, a text without a name) gets nothing.
//   referenceFiles(id)   the image files of a figure (absolute paths, in the order they go to the model)
//
// Pure apart from the file names; the node (lib/nodes/nodes-music-video-hud.js) puts the files into the workflow.

const path = require('path');

const DIR = path.join(__dirname, 'figures');

// The full form of the canon of claudia.gallery (identity.full of https://claudia.gallery/api/canon.json), the FULL: line of the templates.
const CLAUDIA_FULL =
  'a 28-year-old Caucasian American woman with a grown-up angular face, defined cheekbones and a strong jawline, pale skin and light freckles, a glossy black blunt ' +
  'jaw-length bob with heavy straight bangs and one clay-orange streak through the bangs, a small flat clay-orange eight-pointed star hair clip, a thin headset ' +
  'microphone at her cheek';

const FIGURES = Object.freeze({
  claudia: Object.freeze({
    id: 'claudia',
    name: 'Claudia',
    credit: 'Claudia by anabology (claudia.gallery)',
    full: CLAUDIA_FULL,
    // the close-up of the distance set (frontal, studio light), a canon face (photographic, look 00) and face sheet 3 (six angles); see the README
    images: Object.freeze([
      Object.freeze({ id: 'ev-14-dist.dist-cu.2', file: 'ev-14-dist.dist-cu.2.jpg', url: 'https://claudia.gallery/i/ev-14-dist.dist-cu.2/' }),
      Object.freeze({ id: 'ev-17-merge.tag-to-lens.1', file: 'ev-17-merge.tag-to-lens.1.jpg', url: 'https://claudia.gallery/i/ev-17-merge.tag-to-lens.1/' }),
      Object.freeze({ id: 'ev-01.lead-black-face.3', file: 'ev-01.lead-black-face.3.jpg', url: 'https://claudia.gallery/i/ev-01.lead-black-face.3/' })
    ])
  })
});

// the most reference images a figure of the app has (the estimate of the sheet counts them before the plan has run)
const MAX_REFERENCES = Math.max(...Object.values(FIGURES).map((figure) => figure.images.length));

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const plain = (value) => squash(value).replace(/[.;:,\s]+$/, '').toLowerCase();

// The figure of the app a parsed figure names, or null. `figure`: { name, full } of parseFigure (lib/music-video-hud/plan.js).
function figureOf(figure) {
  if (!figure || typeof figure !== 'object') return null;
  const name = squash(figure.name).toLowerCase();
  const full = plain(figure.full);
  if (!full) return null;
  const claudia = FIGURES.claudia;
  if (full === plain(claudia.full) && (!name || name === 'claudia')) return claudia;
  // her name and still her head: the person changed the wording, not the figure
  const namedClaudia = name === 'claudia' || (!name && /^claudia(?:$|[\s,.;:])/.test(full));
  const streak = /\b(?:streak|strähne|mechón|mecha)\b/u.test(full);
  const orange = /\b(?:clay-orange|clay|tonorange[nrms]?|orange[nrms]?|naranja)\b/.test(full);
  if (namedClaudia && /\bbob\b/.test(full) && streak && orange) return claudia;
  return null;
}

function referenceFiles(id) {
  const figure = FIGURES[id];
  if (!figure) return [];
  return figure.images.map((image) => ({ ...image, path: path.join(DIR, figure.id, image.file) }));
}

module.exports = {
  CLAUDIA_FULL,
  FIGURES,
  MAX_REFERENCES,
  figureOf,
  referenceFiles
};
