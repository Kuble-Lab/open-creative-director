// The runtime of the beat effects (WP45) in the browser of the render node. Inlined by composition.js after the runtime of the HUD
// (runtime.browser.js) and effects.js, only when the effects are on. It adds a second tween to the paused timeline of the page (the clock of the HUD):
// for the exact time of every frame it asks HudEffects.frameEffects() what the effects do in that frame and puts it on the picture: the transform and
// the filters of #fx (the wrapper of the footage: zoom, shake, turn, the SVG filters of the distortion, the colour) and the light layer #fx-light
// (flash, strobe), which lies between the footage and the HUD. The layers of the HUD are not touched. Nothing is kept from frame to frame except
// what is on the page (an attribute is only written when it changes).
(function () {
  'use strict';
  var data = window.__HUD_DATA;
  var plan = window.__HUD_FX;
  var by = function (id) { return document.getElementById(id); };
  var fx = by('fx');
  var light = by('fx-light');
  var last = {};

  function put(element, key, attribute, value) {
    if (!element || last[key] === value) return;
    last[key] = value;
    element.setAttribute(attribute, value);
  }

  function applyAt(local) {
    var view = HudEffects.view(HudEffects.frameEffects(plan, data.t0 + Math.max(0, local)));
    put(fx, 'fx', 'style', view.fx);
    put(light, 'light', 'style', view.light);
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
