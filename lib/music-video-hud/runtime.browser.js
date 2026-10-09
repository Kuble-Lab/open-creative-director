// The runtime of a chunk of the music video in the browser of the render node (WP44). Inlined into the page by composition.js after state.js and
// view.js. The page holds the footage (a <video>, which HyperFrames plays and seeks), the layers of the HUD and one paused GSAP timeline that is
// only a clock: a tween of a proxy object over the whole length calls renderAt() with the exact time of every frame, and renderAt() draws the
// whole HUD for that time from scratch (HudState.frameState, HudView.render): no state is kept from frame to frame.
(function () {
  'use strict';
  var data = window.__HUD_DATA;
  var by = function (id) { return document.getElementById(id); };
  var stage = by('stage');
  var cam = by('cam');
  var layers = { dev: by('l-dev'), hud: by('l-hud'), kar: by('l-kar'), over: by('l-over'), end: by('l-end') };
  var last = {};

  function put(key, html) {
    if (last[key] === html) return;
    last[key] = html;
    layers[key].innerHTML = html;
  }

  function renderAt(local) {
    var t = data.t0 + Math.max(0, local);
    var state = HudState.frameState(data.graphics, t, data.options);
    var view = HudView.render(state);
    stage.setAttribute('style', view.stage + (view.hideStage ? ';visibility:hidden' : ''));
    stage.className = view.ink === 'dark' ? 'ink-dark' : '';
    cam.setAttribute('style', view.cam);
    put('dev', view.dev);
    put('hud', view.hud);
    put('kar', view.kar);
    put('over', view.over);
    put('end', view.end);
  }

  window.__hudRenderAt = renderAt;
  var proxy = { t: 0 };
  var timeline = gsap.timeline({ paused: true });
  timeline.to(proxy, { t: data.duration, duration: data.duration, ease: 'none', onUpdate: function () { renderAt(proxy.t); } }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines['main'] = timeline;
  renderAt(0);
})();
