// Optional presentation adapters for the same HUD engine. Loaded only for Camcorder or an active chorus-word schedule.
// New writing goes through textContent; the existing escaped device renderer is reused without a second device implementation.
(function () {
  'use strict';
  const data = window.__HUD_DATA;
  const State = window.HudState;
  const View = window.HudView;
  const tape = data.graphics.theme === 'camcorder';
  const frame = document.getElementById('l-tape');
  const wordLayer = document.getElementById('l-words');
  const wordText = wordLayer ? wordLayer.firstElementChild : null;
  const originalState = State.frameState;
  const originalView = View.render;
  const targets = window.HudTargets;
  const pad = (n) => String(n).padStart(2, '0');

  State.frameState = function (g, t, options) {
    let state = originalState(g, t, options);
    if (tape) {
      state.theme = 'camcorder';
      state.ink = 'light';
      state.devices = state.devices.map((d) => ({ ...d, ink: 'light' }));
    }
    if (data.chorus) {
      const cut = g.cuts.find((c) => t >= c.start && t < c.end);
      const zone = (data.chorus.zones || []).find((z) => t >= z.start && t < z.end);
      const boxes = zone && zone.box ? [zone.box] : [];
      const fx = window.HudEffects && window.__HUD_FX ? window.HudEffects.frameEffects(window.__HUD_FX, t) : null;
      // Keep the frame free when time effects expose several different faces or a different source frame.
      const copies = window.__HUD_FX ? window.__HUD_FX.copies || [] : [];
      const changing = copies.some((c) => t * 24 >= c.f && t * 24 < c.f + c.n);
      const face = cut && cut.subject !== 'none' ? (g.faces ? targets.faceAt(g.faces, cut, Math.round(t * 24)) : targets.guessedFace(cut)) : null;
      const measured = face ? targets.boxOf(face, 'face', state.camera, fx) : null;
      if (measured) boxes.push(measured);
      // The measured cut zone already includes the crop. Expand it for the current camera kick and beat transform as well.
      if (zone && zone.box && (state.kick || fx)) {
        const b = zone.box;
        const camera = { scale: 1 + state.kick, tx: -960 * state.kick, ty: -540 * state.kick };
        const points = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map((p) => targets.toScreen(p, camera, fx));
        boxes.push({ x0: Math.min(...points.map((p) => p[0])), y0: Math.min(...points.map((p) => p[1])), x1: Math.max(...points.map((p) => p[0])), y1: Math.max(...points.map((p) => p[1])) });
      }
      for (const d of state.devices) if (d.type !== 'display') for (const r of d.d.occupies || [d.rect]) boxes.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
      if (changing) boxes.push({ x0: 0, y0: 0, x1: 1920, y1: 1080 });
      state = window.HudChorusWords.frameState(state, data.chorus, boxes, tape ? 180 : 220);
    }
    return state;
  };

  View.render = function (state) {
    const out = originalView(state);
    if (tape) {
      const cx = View.contextOf('camcorder');
      const tagged = targets && state.devices.some((d) => d.type === 'tag');
      const fx = window.HudEffects && window.__HUD_FX ? window.HudEffects.frameEffects(window.__HUD_FX, state.t) : null;
      const marks = tagged ? targets.subjectHtml(state, data.graphics, fx, false, window.__HUD_FX ? window.__HUD_FX.copies || [] : []) : '';
      out.dev = marks + View.devicesHtml(state.devices, tagged ? 'none' : state.cut ? state.cut.subject : 'center', cx);
      out.hud = '';
      frame.hidden = Boolean(state.endcard);
      const seconds = Math.max(0, Math.floor(state.t + 1e-6));
      const date = new Date(Date.UTC(1998, 0, 1, 12) + seconds * 1000);
      document.getElementById('tape-date').textContent = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}  ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
      document.getElementById('tape-time').textContent = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
      document.getElementById('tape-dot').style.opacity = Math.floor(state.t * 2) % 2 === 0 ? '1' : '0';
    }
    if (wordLayer) {
      const w = state.chorusWord;
      wordLayer.hidden = !w;
      if (w) {
        wordText.textContent = w.text;
        wordLayer.style.cssText = `left:${w.rect.x}px;top:${w.rect.y}px;width:${w.rect.w}px;height:${w.rect.h}px;font-size:${w.rect.size}px;color:${w.accent ? 'var(--acc)' : 'var(--word-ink,#F4F2EA)'}`;
        wordText.style.cssText = `opacity:${w.opacity};transform:translate(${w.x}px,${w.y}px) scale(${w.scale})`;
      }
    }
    return out;
  };
})();
