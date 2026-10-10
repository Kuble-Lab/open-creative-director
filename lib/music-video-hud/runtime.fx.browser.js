// The runtime of the beat effects (WP45, WP49) in the browser of the render node. Inlined by composition.js after the runtime of the HUD
// (runtime.browser.js) and effects.js, only when the effects are on. It adds a second tween to the paused timeline of the page (the clock of the HUD):
// for the exact time of every frame it asks HudEffects.frameEffects() what the effects do in that frame and puts it on the picture: the transform and
// the filters of #fx (the wrapper of the footage: zoom, shake, turn, the SVG filters of the distortion and the glitch, the colour), the filters of #fxall
// (the wrapper of the whole picture: the glitch over the HUD too), the layers of noise and scanlines over the footage (#fx-grain, #fx-scan), the snow
// over everything (#fx-snow) and the light layer #fx-light (flash, strobe), which lies between the footage and the HUD. The layers of the HUD are not
// touched; the copies of the footage (freeze, stutter, echo, mirror) are clips of HyperFrames in the page and need nothing from here. Nothing is kept
// from frame to frame except what is on the page (an attribute is only written when it changes).
(function () {
  'use strict';
  var data = window.__HUD_DATA;
  var plan = window.__HUD_FX;
  var by = function (id) { return document.getElementById(id); };
  var layers = { fx: by('fx'), all: by('fxall'), light: by('fx-light'), grain: by('fx-grain'), scan: by('fx-scan'), snow: by('fx-snow') };
  var last = {};

  function put(element, key, attribute, value) {
    if (!element || last[key] === value) return;
    last[key] = value;
    element.setAttribute(attribute, value);
  }

  function applyAt(local) {
    var view = HudEffects.view(HudEffects.frameEffects(plan, data.t0 + Math.max(0, local)));
    put(layers.fx, 'fx', 'style', view.fx);
    put(layers.all, 'all', 'style', view.all);
    put(layers.light, 'light', 'style', view.light);
    put(layers.grain, 'grain', 'style', view.grain);
    put(layers.scan, 'scan', 'style', view.scan);
    put(layers.snow, 'snow', 'style', view.snow);
    for (var i = 0; i < view.svg.length; i += 1) {
      var item = view.svg[i];
      put(by(item[0]), item[0] + ' ' + item[1], item[1], item[2]);
    }
  }

  var timeline = window.__timelines && window.__timelines.main;
  if (timeline) {
    var proxy = { t: 0 };
    timeline.to(proxy, { t: data.duration, duration: data.duration, ease: 'none', onUpdate: function () { applyAt(proxy.t); } }, 0);
  }
  window.__hudFxAt = applyAt;
  applyAt(0);
})();
