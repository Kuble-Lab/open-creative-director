// The frame of the Zine style on the same HUD engine. Loaded only for a page of that style, after the optional chorus adapter.
// The devices keep the renderer of HUD Blue; the frame of HUD Blue is not drawn, the paper frame is filled through textContent.
(function () {
  'use strict';
  const data = window.__HUD_DATA;
  const View = window.HudView;
  const frame = document.getElementById('l-zine');
  const drawn = View.render;
  const pad = (n) => String(n).padStart(2, '0');
  const g = data.graphics;
  const total = Math.max(1, Number(g.duration) || (Number(g.endFrame) || 0) / 24 || data.t0 + data.duration);

  View.render = function (state) {
    const out = drawn(state);
    out.hud = '';
    // the paper ink of the devices is fixed by the style sheet: the frame never turns dark
    out.ink = 'light';
    frame.hidden = Boolean(state.endcard);
    const seconds = Math.max(0, Math.floor(state.t + 1e-6));
    document.getElementById('zine-no').textContent = `N° ${pad((state.cut ? state.cut.index : 0) + 1)}`;
    document.getElementById('zine-time').textContent = `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
    // the row fills dot by dot (a dot is 24 px wide)
    const share = Math.min(1, Math.max(0, state.t / total));
    document.getElementById('zine-fill').style.width = `${Math.round(share * 1812 / 24) * 24}px`;
    return out;
  };
})();
