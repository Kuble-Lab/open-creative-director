'use strict';

// Where a tag of the HUD points (WP51): every tag names a place on the figure (`target`: face, eyes, mouth, hair, hands, outfit, object or none; the
// planner writes it, and without it the words of the tag say it: "LIP GLOSS ON" is the mouth). Its leader line ends at brackets round that place, and
// the place is where the face really is in the footage: the track that faces.js measured before the render (the middle between the pupils, their
// distance and the angle of the line through them, every few frames), followed from frame to frame. The mouth, the hair and the clothes are where
// they are in a face of that size and turn (SHAPES, measured on the faces of a film of ours). The track goes through the transform of the picture:
// the crop of the cut (the camera of state.js) and, with the beat effects on, the zoom, move and turn of the footage (effects.js).
//   - a measured film whose face is not found in a frame (turned away, too small, not there): the tag stands alone, without line and brackets
//   - a film that was not measured (the track is missing, as in plans drawn before): the place is guessed from the framing and the crop of the cut
//   - hands, an object and none: no line (nothing measures them)
//   - the line keeps off the eyes and the mouth when it points at something else
// Only the pages of chunks with a tag carry this script (composition.js); it takes over the brackets and lines that view.js draws for a tag
// (install(): the brackets of view.js are switched off by a cut without the figure, everything else of view.js is drawn as before). A page without a
// tag is the page of before, byte for byte.
// UMD: runs in Node (the tests, the tools) and in the browser (inlined in the page of a chunk).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.HudTargets = factory();
    if (root.HudView && root.__HUD_DATA) root.HudTargets.install(root.HudView, root.__HUD_DATA, root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const FPS = 24;
  const TARGETS = Object.freeze(['face', 'eyes', 'mouth', 'hair', 'hands', 'outfit', 'object', 'none']);
  // the places that follow from the face; the others have no line
  const LOCATED = Object.freeze(['face', 'eyes', 'mouth', 'hair', 'outfit']);
  const FALLBACK = 'face';

  // The words that name a place, in the languages of the screen and of the songs (English, German, Spanish) and a few more (French, Italian).
  // Upper case without accents; only exact words and the compounds listed here count.
  // The first word of the tag that names a place decides.
  const WORDS = Object.freeze({
    mouth: ['LIP', 'LIPS', 'GLOSS', 'LIPGLOSS', 'LIPPENSTIFT', 'LIPPENGLOSS', 'LIPSTICK', 'LIPLINER', 'MOUTH', 'SMILE', 'SMILING', 'GRIN', 'TEETH', 'KISS', 'KISSES', 'TONGUE', 'POUT', 'SINGS', 'SINGING', 'LIPPE', 'LIPPEN', 'MUND', 'LACHELN', 'KUSS', 'ZAHNE', 'LABIO', 'LABIOS', 'BOCA', 'SONRISA', 'BESO', 'DIENTES', 'BOUCHE', 'LEVRES', 'SOURIRE', 'BAISER', 'BOCCA', 'LABBRA', 'SORRISO', 'BACIO'],
    eyes: ['EYE', 'EYES', 'EYELINER', 'MASCARA', 'LASH', 'LASHES', 'GAZE', 'STARE', 'STARING', 'BLINK', 'WINK', 'PUPIL', 'PUPILS', 'IRIS', 'BROW', 'BROWS', 'EYEBROW', 'EYEBROWS', 'TEARS', 'LIDS', 'AUGE', 'AUGEN', 'WIMPERN', 'BLICK', 'BRAUE', 'BRAUEN', 'TRANEN', 'OJO', 'OJOS', 'MIRADA', 'PESTANAS', 'CEJAS', 'LAGRIMAS', 'YEUX', 'OEIL', 'REGARD', 'CILS', 'OCCHI', 'OCCHIO', 'SGUARDO', 'CIGLIA'],
    hair: ['HAIR', 'HAIRCUT', 'HAIRSTYLE', 'BANGS', 'FRINGE', 'BOB', 'PONYTAIL', 'CURLS', 'BRAID', 'BRAIDS', 'WIG', 'HAIRPIN', 'BARRETTE', 'HAAR', 'HAARE', 'HAARSPANGE', 'HAARREIF', 'HAARFARBE', 'FRISUR', 'ZOPF', 'LOCKEN', 'PERUCKE', 'SPANGE', 'PONY', 'PELO', 'CABELLO', 'FLEQUILLO', 'PEINADO', 'TRENZA', 'PELUCA', 'CHEVEUX', 'FRANGE', 'CAPELLI', 'FRANGIA'],
    hands: ['HAND', 'HANDS', 'FINGER', 'FINGERS', 'NAIL', 'NAILS', 'MANICURE', 'RING', 'RINGS', 'PALM', 'PALMS', 'FIST', 'THUMB', 'THUMBS', 'GRIP', 'HANDE', 'NAGEL', 'FAUST', 'DAUMEN', 'MANO', 'MANOS', 'DEDO', 'DEDOS', 'UNAS', 'PUNO', 'ANILLO', 'DOIGT', 'DOIGTS', 'ONGLES', 'DITA', 'UNGHIE'],
    outfit: ['DRESS', 'OUTFIT', 'SHIRT', 'TSHIRT', 'JACKET', 'COAT', 'GOWN', 'HOODIE', 'SWEATER', 'COLLAR', 'NECKLACE', 'WARDROBE', 'SUIT', 'BLAZER', 'SCARF', 'TIE', 'JEWELRY', 'JEWELLERY', 'PENDANT', 'KLEID', 'HEMD', 'JACKE', 'MANTEL', 'PULLI', 'PULLOVER', 'KETTE', 'HALSKETTE', 'SCHAL', 'ANZUG', 'KRAGEN', 'VESTIDO', 'CAMISA', 'CHAQUETA', 'ABRIGO', 'COLLAR', 'ROPA', 'BUFANDA', 'ROBE', 'CHEMISE', 'VESTE', 'MANTEAU', 'COLLIER', 'ABITO', 'GIACCA', 'CAMICIA'],
    face: ['FACE', 'FACES', 'SKIN', 'CHEEK', 'CHEEKS', 'FOUNDATION', 'BLUSH', 'MAKEUP', 'CONCEALER', 'FRECKLES', 'NOSE', 'CHIN', 'JAW', 'HEAD', 'EARRING', 'EARRINGS', 'GESICHT', 'HAUT', 'WANGE', 'WANGEN', 'NASE', 'KINN', 'KOPF', 'SOMMERSPROSSEN', 'OHRRING', 'CARA', 'ROSTRO', 'PIEL', 'MEJILLA', 'MEJILLAS', 'NARIZ', 'CABEZA', 'VISAGE', 'PEAU', 'JOUE', 'TETE', 'VISO', 'PELLE'],
    object: ['PHONE', 'SMARTPHONE', 'SCREEN', 'LAPTOP', 'CAMERA', 'MIC', 'MICROPHONE', 'MIRROR', 'CUP', 'COFFEE', 'BAG', 'CAR', 'KEYS', 'TICKET', 'BOTTLE', 'GLASS', 'BOOK', 'LAMP', 'HANDY', 'BILDSCHIRM', 'KAMERA', 'SPIEGEL', 'TASSE', 'TASCHE', 'FLASCHE', 'BUCH', 'TELEFONO', 'MOVIL', 'PANTALLA', 'ESPEJO', 'TAZA', 'BOLSO', 'COCHE', 'BOTELLA', 'LIBRO', 'TELEPHONE', 'ECRAN', 'MIROIR', 'SPECCHIO']
  });
  const ORDER = Object.freeze(['mouth', 'eyes', 'hair', 'hands', 'outfit', 'face', 'object']);
  const LOOKUP = (() => {
    const exact = {};
    for (const target of ORDER) {
      for (const word of WORDS[target]) if (!(word in exact)) exact[word] = target;
    }
    return { exact };
  })();

  // The words of a text in upper case without accents (Ä is A: LÄCHELN is LACHELN).
  function wordsOf(text) {
    return String(text === undefined || text === null ? '' : text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean);
  }

  // The place a text names, or the fallback (the face) when no word of it names one.
  function targetFromText(text) {
    for (const word of wordsOf(text)) {
      if (LOOKUP.exact[word]) return LOOKUP.exact[word];
    }
    return FALLBACK;
  }

  // The place of a tag: the one of the plan when it is a known one, else the one its words name.
  function targetOf(d) {
    const given = d && typeof d.target === 'string' ? d.target.trim().toLowerCase() : '';
    return TARGETS.includes(given) ? given : targetFromText(d && d.text);
  }

  // The places in pupil units round the middle between the pupils, along the line through them (u) and across it, down (v): [u, v, width, height] of the
  // box the brackets go round. Measured on the faces of a film of ours (MediaPipe, 314 frames, the median): the mouth 1.19 below the pupils, the
  // hairline 0.75 above them, the chin 1.93 below, the face 2.3 wide and 2.7 high; the brackets leave a little room.
  const SHAPES = Object.freeze({
    eyes: Object.freeze([0, 0, 2.1, 0.8]),
    mouth: Object.freeze([0, 1.19, 1.35, 0.75]),
    face: Object.freeze([0, 0.6, 2.5, 3.0]),
    hair: Object.freeze([0, -1.25, 2.7, 1.1]),
    outfit: Object.freeze([0, 3.4, 3.4, 1.6])
  });
  // what the line keeps off when it points at another place
  const AVOID = Object.freeze({ face: [], eyes: ['mouth'], mouth: ['eyes'], hair: ['eyes', 'mouth'], outfit: ['eyes', 'mouth'] });

  // A film that was not measured: where the pupils are on the screen by the framing of the cut (the height and their distance; measured on the same
  // film: about 400 px from the top in a close-up as in a medium shot, 200 px apart in a close-up, 135 in a medium shot) and across by the subject.
  const GUESS_X = Object.freeze({ left: 520, center: 960, right: 1400 });
  const GUESS = Object.freeze({
    ECU: Object.freeze({ y: 400, d: 290 }),
    CU: Object.freeze({ y: 410, d: 200 }),
    MCU: Object.freeze({ y: 410, d: 185 }),
    MS: Object.freeze({ y: 400, d: 135 }),
    MWS: Object.freeze({ y: 380, d: 90 }),
    WS: Object.freeze({ y: 360, d: 55 }),
    FS: Object.freeze({ y: 340, d: 40 }),
    EWS: Object.freeze({ y: 330, d: 25 }),
    OTS: Object.freeze({ y: 400, d: 120 }),
    none: Object.freeze({ y: 410, d: 150 })
  });

  // How far apart two points of the track may be and still be joined (frames), how long the first and last point of a run hold, and the fade at the
  // ends of a run inside a cut (at a cut the line comes and goes with the picture).
  const JOIN_FRAMES = 12;
  const HOLD_FRAMES = 4;
  const FADE_FRAMES = 4;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const r1 = (value) => Math.round(value * 10) / 10;
  const r2 = (value) => Math.round(value * 100) / 100;

  // The cut of the film at song time t (the list is sorted).
  function cutAt(cuts, t) {
    let found = null;
    for (const cut of cuts || []) {
      if (cut.start <= t + 1e-6) found = cut;
      else break;
    }
    return found;
  }

  // The face at frame `frame` of the song in the footage: { x, y, d, a, alpha } (alpha: 0 to 1, the fade at the ends of a run), or null. The track is
  // { step, points: [[frame, x, y, d, a], ...] }; only points of the same cut count. Between two points that are at most JOIN_FRAMES apart the face
  // moves in a straight line; the first and the last point of a run hold for HOLD_FRAMES.
  function faceAt(track, cut, frame) {
    if (!track || !cut || !Array.isArray(track.points) || !track.points.length) return null;
    const first = Math.round(cut.start * FPS);
    const last = Math.round(cut.end * FPS) - 1;
    const points = track.points;
    // the last point at or before the frame (binary search)
    let low = 0;
    let high = points.length - 1;
    let at = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid][0] <= frame) {
        at = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    const inCut = (point) => point && point[0] >= first && point[0] <= last;
    const before = at >= 0 && inCut(points[at]) ? points[at] : null;
    const after = at + 1 < points.length && inCut(points[at + 1]) ? points[at + 1] : null;
    let face = null;
    let anchor = at;
    if (before && after && after[0] - before[0] <= JOIN_FRAMES) {
      const x = after[0] === before[0] ? 0 : (frame - before[0]) / (after[0] - before[0]);
      const lerp = (i) => before[i] + (after[i] - before[i]) * x;
      face = { x: lerp(1), y: lerp(2), d: lerp(3), a: lerp(4) };
    } else if (before && frame - before[0] <= HOLD_FRAMES) face = { x: before[1], y: before[2], d: before[3], a: before[4] };
    else if (after && after[0] - frame <= HOLD_FRAMES) {
      face = { x: after[1], y: after[2], d: after[3], a: after[4] };
      anchor = at + 1;
    }
    if (!face) return null;
    // the run the frame lies in: from its first point to its last one (points at most JOIN_FRAMES apart, inside the cut)
    let start = anchor;
    while (start > 0 && inCut(points[start - 1]) && points[start][0] - points[start - 1][0] <= JOIN_FRAMES) start -= 1;
    let end = anchor;
    while (end + 1 < points.length && inCut(points[end + 1]) && points[end + 1][0] - points[end][0] <= JOIN_FRAMES) end += 1;
    const runFrom = points[start][0] - HOLD_FRAMES;
    const runTo = points[end][0] + HOLD_FRAMES;
    const fadeIn = runFrom <= first ? 1 : clamp((frame - runFrom + 1) / FADE_FRAMES, 0, 1);
    const fadeOut = runTo >= last ? 1 : clamp((runTo - frame + 1) / FADE_FRAMES, 0, 1);
    face.alpha = Math.min(fadeIn, fadeOut);
    return face;
  }

  // The guessed face of a film that was not measured: in the footage, by the framing and the subject of the cut.
  function guessedFace(cut) {
    if (!cut || cut.subject === 'none') return null;
    const guess = GUESS[cut.framing] || GUESS.none;
    return { x: GUESS_X[cut.subject] || GUESS_X.center, y: guess.y, d: guess.d, a: 0, alpha: 1, guessed: true };
  }

  // A point of the footage on the screen: the crop of the cut (camera: translate(tx, ty) scale(scale) from the top left corner) and the transform of
  // the beat effects round the middle of the screen (translate(x, y) rotate(rot) scale(zoom)).
  function toScreen(point, camera, fx) {
    let x = point[0] * camera.scale + camera.tx;
    let y = point[1] * camera.scale + camera.ty;
    if (fx && (fx.zoom !== 1 || fx.x || fx.y || fx.rot)) {
      const turn = ((fx.rot || 0) * Math.PI) / 180;
      const dx = (x - WIDTH / 2) * (fx.zoom || 1);
      const dy = (y - HEIGHT / 2) * (fx.zoom || 1);
      x = WIDTH / 2 + (fx.x || 0) + dx * Math.cos(turn) - dy * Math.sin(turn);
      y = HEIGHT / 2 + (fx.y || 0) + dx * Math.sin(turn) + dy * Math.cos(turn);
    }
    return [x, y];
  }

  // The box of a place on the screen: { x0, y0, x1, y1 } (upright: the brackets are not turned), or null when nothing of it is on the screen.
  function boxOf(face, target, camera, fx) {
    const shape = SHAPES[target];
    if (!shape || !face) return null;
    const turn = (face.a * Math.PI) / 180;
    const [u, v, w, h] = shape;
    const centre = [face.x + face.d * (u * Math.cos(turn) - v * Math.sin(turn)), face.y + face.d * (u * Math.sin(turn) + v * Math.cos(turn))];
    const [cx, cy] = toScreen(centre, camera, fx);
    const scale = camera.scale * (fx && fx.zoom ? fx.zoom : 1);
    // the box of the turned rectangle
    const cos = Math.abs(Math.cos(turn));
    const sin = Math.abs(Math.sin(turn));
    const halfW = (face.d * scale * (w * cos + h * sin)) / 2;
    const halfH = (face.d * scale * (w * sin + h * cos)) / 2;
    const box = { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH };
    // kept on the screen; a place that is mostly off it (the clothes below a close-up) is not pointed at
    const kept = { x0: Math.max(8, box.x0), y0: Math.max(8, box.y0), x1: Math.min(WIDTH - 8, box.x1), y1: Math.min(HEIGHT - 8, box.y1) };
    if (kept.x1 - kept.x0 < 0.5 * (box.x1 - box.x0) || kept.y1 - kept.y0 < 0.5 * (box.y1 - box.y0)) return null;
    return kept;
  }

  // Does the segment from a to b cross the box (Liang-Barsky)?
  function crosses(a, b, box) {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const sides = [[-dx, a[0] - box.x0], [dx, box.x1 - a[0]], [-dy, a[1] - box.y0], [dy, box.y1 - a[1]]];
    for (const [p, q] of sides) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return false;
      }
    }
    return true;
  }

  // The leader line from a tag (its rect) to the box of its place, as the points of a polyline. It starts at the side of the tag that faces the box and
  // ends on the near side of the box, as level as the box allows; when that line would cross the eyes or the mouth (`avoid`), another point of the
  // box is tried (its middle, its corners, the middle of its top or bottom), then routes beside or above and below the obstacles.
  // Every segment must be clear and on screen; without a free route only the brackets remain.
  function lineOf(rect, box, avoid = []) {
    const cx = (box.x0 + box.x1) / 2;
    const leftOf = rect.x + rect.w / 2 < cx;
    const from = [leftOf ? rect.x + rect.w : rect.x, rect.y + rect.h / 2];
    const near = leftOf ? box.x0 : box.x1;
    const h = box.y1 - box.y0;
    const level = [near, clamp(from[1], box.y0 + 0.25 * h, box.y1 - 0.25 * h)];
    const candidates = [level, [near, (box.y0 + box.y1) / 2], [near, box.y0 + 0.1 * h], [near, box.y1 - 0.1 * h], [cx, box.y0], [cx, box.y1]];
    const clear = (a, b) => avoid.every((other) => !crosses(a, b, other));
    for (const end of candidates) if (clear(from, end)) return [from, end];
    const all = avoid.concat([box]);
    const sides = [Math.min(...all.map((other) => other.x0)) - 24, Math.max(...all.map((other) => other.x1)) + 24];
    if (!leftOf) sides.reverse();
    const levels = [Math.min(...all.map((other) => other.y0)) - 24, Math.max(...all.map((other) => other.y1)) + 24];
    const free = (points) => points.every(([x, y]) => x >= 8 && x <= WIDTH - 8 && y >= 8 && y <= HEIGHT - 8)
      && points.slice(1).every((point, i) => clear(points[i], point));
    for (const end of candidates) {
      for (const side of sides) {
        const route = [from, [side, from[1]], [side, end[1]], end];
        if (free(route)) return route;
      }
      for (const y of levels) {
        const route = [from, [from[0], y], [end[0], y], end];
        if (free(route)) return route;
        for (const side of sides) {
          const around = [from, [side, from[1]], [side, y], [end[0], y], end];
          if (free(around)) return around;
        }
      }
    }
    return [];
  }

  // The brackets round a box: four corners, each two arms of up to 34 px.
  function bracketsOf(box) {
    const arm = clamp(0.22 * Math.min(box.x1 - box.x0, box.y1 - box.y0), 10, 34);
    return [[box.x0, box.y0, 1, 1], [box.x1, box.y0, -1, 1], [box.x0, box.y1, 1, -1], [box.x1, box.y1, -1, -1]]
      .map(([x, y, sx, sy]) => `<path d="M${r1(x)} ${r1(y + sy * arm)} V${r1(y)} H${r1(x + sx * arm)}" />`)
      .join('');
  }

  const alphaOf = (item) => clamp(item.enter * (1 - item.leave), 0, 1);

  // The brackets and leader lines of the tags of a frame: the SVG of the layer of the devices (the first thing of it, under the devices), '' when there
  // is nothing to point at. `state` is the state of the frame (state.js frameState), `g` the data of the page (its cuts and the track `faces`), `fx`
  // the transform of the beat effects in the frame (or null), `kuble` the style, `copies` the footage clips of the effect plan.
  function subjectHtml(state, g, fx = null, kuble = false, copies = []) {
    const tags = (state.devices || []).filter((item) => item.type === 'tag');
    if (!tags.length || !state.cut) return '';
    const frame = Math.round(state.t * FPS);
    const active = copies.filter((copy) => frame >= copy.f && frame < copy.f + copy.n);
    // Plain copies cover the footage. Echoes and partial mirrors show several possible places.
    if (active.some((copy) => copy.s !== 'plain')) return '';
    const copy = active[active.length - 1];
    const mediaFrame = copy ? copy.m + (frame - copy.f) * copy.r : frame;
    const cut = cutAt(g.cuts, mediaFrame / FPS);
    if (!cut || cut.subject === 'none') return '';
    const face = g.faces ? faceAt(g.faces, cut, copy ? Math.floor(mediaFrame + 1e-6) : frame) : guessedFace(cut);
    if (!face || face.alpha <= 0) return '';
    const camera = state.camera || { scale: 1, tx: 0, ty: 0 };
    const boxes = {};
    const box = (target) => {
      if (!(target in boxes)) boxes[target] = boxOf(face, target, camera, fx);
      return boxes[target];
    };
    const marks = {};
    let lines = '';
    for (const item of tags) {
      const target = targetOf(item.d);
      if (!LOCATED.includes(target)) continue;
      const place = box(target);
      if (!place) continue;
      const alpha = alphaOf(item) * face.alpha;
      marks[target] = Math.max(marks[target] || 0, alpha);
      const avoid = AVOID[target].map(box).filter(Boolean);
      const points = lineOf(item.rect, place, avoid);
      if (points.length) lines += `<path d="M${points.map((point) => `${r1(point[0])} ${r1(point[1])}`).join(' L')}" opacity="${r2(alpha * 0.9)}" />`;
    }
    const targets = Object.keys(marks);
    if (!targets.length) return '';
    const corners = targets.map((target) => `<g opacity="${r2(marks[target])}">${bracketsOf(box(target))}</g>`).join('');
    return `<svg class="subj" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" fill="none" stroke="${kuble ? 'var(--sub)' : 'rgba(255,255,255,.9)'}" stroke-width="2.2">${corners}${lines}</svg>`;
  }

  // In the page: the view draws as before, but for a frame with a tag its own brackets are switched off (the cut is drawn as one without the figure)
  // and these are put first into the layer of the devices. `root` holds the effects (HudEffects and the plan of the page) when they are on.
  function install(View, data, root) {
    const base = View.render;
    View.render = function (state) {
      const tagged = state && state.cut && (state.devices || []).some((item) => item.type === 'tag');
      if (!tagged) return base(state);
      const out = base({ ...state, cut: { ...state.cut, subject: 'none' } });
      const fx = root && root.HudEffects && root.__HUD_FX ? root.HudEffects.frameEffects(root.__HUD_FX, state.t) : null;
      out.dev = subjectHtml(state, data.graphics, fx, state.theme === 'kuble', root && root.__HUD_FX ? root.__HUD_FX.copies || [] : []) + out.dev;
      return out;
    };
    return View;
  }

  return { TARGETS, LOCATED, FALLBACK, WORDS, SHAPES, AVOID, GUESS, GUESS_X, JOIN_FRAMES, HOLD_FRAMES, FADE_FRAMES, wordsOf, targetFromText, targetOf, faceAt, guessedFace, toScreen, boxOf, crosses, lineOf, subjectHtml, install };
});
