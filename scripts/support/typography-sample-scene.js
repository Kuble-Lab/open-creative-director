'use strict';

// A scene as the model is asked to write it in the style "typography" (WP40): the tools it names in the prompt - words as <span data-at>,
// one loop for the tweens, an SVG block with textLength, an SVG filter for the motion blur tweened with gsap attr, a textPath, 3D blocks,
// mix-blend-mode - written out once, so that the tests can hold the rules of the check of the code (checkCode) against them: what the
// prompt recommends must pass the check, or the prompt asks for the impossible.

function sampleScene({ width = 1920, height = 1080, duration = '7.399', family = 'Inter Tight' } = {}) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  body,html { margin:0; width:${width}px; height:${height}px; overflow:hidden; background:#e7e0d0; }
  #main-composition { position:relative; width:${width}px; height:${height}px; overflow:hidden; font-family:'${family}', system-ui, sans-serif; color:#111111; }
  #vignette { position:absolute; left:0; top:0; width:${width}px; height:${height}px; background:radial-gradient(ellipse at 50% 45%, #ece7da 0%, #e7e0d0 40%, #8b867d 100%); }
  #stage { position:absolute; left:0; top:0; width:${width}px; height:${height}px; transform-origin:50% 50%; perspective:1400px; transform-style:preserve-3d; }
  .w { position:absolute; opacity:0; font-weight:300; font-size:64px; text-transform:lowercase; }
  .k { position:absolute; opacity:0; font-weight:900; font-size:420px; color:#d8412c; text-transform:uppercase; filter:url(#motionblur); mix-blend-mode:multiply; }
  .face { position:absolute; width:400px; height:600px; background:#8c8a84; color:#ffffff; transform:rotateY(90deg) translateZ(200px); }
  .label { position:absolute; font-size:30px; letter-spacing:0.3em; color:#514f4a; text-transform:uppercase; }
</style>
</head>
<body>
<div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}">
  <div id="vignette"></div>
  <svg width="0" height="0" style="position:absolute"><defs><filter id="motionblur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur id="mb" in="SourceGraphic" stdDeviation="70 0"/></filter></defs></svg>
  <div id="stage">
    <span class="w" data-at="0.35" style="left:240px;top:200px">during the</span>
    <span class="k" data-at="0.92" style="left:200px;top:260px">1950</span>
    <svg id="block" width="1200" height="520" viewBox="0 0 1200 520" style="position:absolute;left:360px;top:300px">
      <text x="0" y="170" font-family="${family}" font-weight="900" font-size="190" textLength="1200" lengthAdjust="spacingAndGlyphs">TECH</text>
      <text x="0" y="330" font-family="${family}" font-weight="900" font-size="170" textLength="1200" lengthAdjust="spacingAndGlyphs">NOLOGY</text>
      <path id="curve" d="M0 480 C 300 380, 900 380, 1200 480" fill="none"/>
      <text font-family="${family}" font-weight="700" font-size="70"><textPath href="#curve" startOffset="0%">of the century</textPath></text>
    </svg>
    <div class="face" style="left:1300px;top:200px"><span class="label">Variant A</span></div>
    <span class="label" data-at="3.1" style="left:240px;top:760px;opacity:0">Variant B</span>
  </div>
  <script>
    const tl = gsap.timeline({paused:true});
    window.__timelines = window.__timelines || {};
    window.__timelines['main'] = tl;
    tl.fromTo('#stage', {scale:1.04, rotation:-1}, {scale:1.22, rotation:1, duration:7.3, ease:'none'}, 0);
    document.querySelectorAll('.w').forEach((el) => {
      const at = parseFloat(el.dataset.at);
      tl.fromTo(el, {opacity:0, x:-40}, {opacity:1, x:0, duration:0.22, ease:'power2.out'}, Math.max(0, at - 0.1));
    });
    document.querySelectorAll('.k').forEach((el) => {
      const at = parseFloat(el.dataset.at);
      tl.fromTo(el, {opacity:0, scale:2.2, x:-600}, {opacity:1, scale:1, x:0, duration:0.45, ease:'back.out(2)'}, Math.max(0, at - 0.12));
      tl.fromTo('#mb', {attr:{stdDeviation:'70 0'}}, {attr:{stdDeviation:'0 0'}, duration:0.3, ease:'power2.out'}, Math.max(0, at - 0.12));
    });
    tl.to('#block textPath', {attr:{startOffset:'60%'}, duration:2, ease:'power1.inOut'}, 1);
    tl.to({}, {duration:0.01}, ${Number(duration) - 0.01});
  </script>
</div>
</body>
</html>`;
}

module.exports = { sampleScene };
