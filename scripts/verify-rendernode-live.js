'use strict';

const assert = require('assert/strict');

const { loadEnv } = require('../lib/config');

loadEnv();

const rendernode = require('../lib/rendernode');

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 8 * 60 * 1000;
const TEST_ASSET_NAME = 'verify-asset.png';
const testAssets = {
  [TEST_ASSET_NAME]: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
};

const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    body,html { margin:0; width:1920px; height:1080px; overflow:hidden; }
    #main-composition { position:relative; width:1920px; height:1080px; overflow:hidden; font-family:Arial,sans-serif; }
    .background { position:absolute; inset:0; background:#05070c; }
    #asset { position:absolute; left:180px; top:210px; width:720px; height:660px; object-fit:cover; background:#2e5cff; opacity:0.85; }
    #title { position:absolute; left:240px; top:390px; width:1440px; color:#ffffff; font-size:112px; line-height:1; font-weight:700; opacity:0; }
    #bar { position:absolute; left:240px; top:565px; width:0; height:16px; background:#2e5cff; }
  </style>
</head>
<body>
  <div id="main-composition" data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="4">
    <div class="background"></div>
    <img id="asset" src="${TEST_ASSET_NAME}" alt="Test-Asset">
    <div id="title">Render-Node Test</div>
    <div id="bar"></div>
    <script>
      const tl = gsap.timeline({paused:true});
      tl.fromTo('#asset', {scale:0.75, rotation:-8, opacity:0}, {scale:1, rotation:0, opacity:0.85, duration:1.1, ease:'power3.out'}, 0);
      tl.fromTo('#title', {x:-80, opacity:0}, {x:0, opacity:1, duration:0.8, ease:'power3.out'}, 0.2);
      tl.to('#bar', {width:980, duration:1.1, ease:'power2.inOut'}, 0.45);
      tl.to('#title', {opacity:0, duration:0.5, ease:'power2.in'}, 3.25);
      window.__timelines = window.__timelines || {};
      window.__timelines['main'] = tl;
    </script>
  </div>
</body>
</html>`;

async function main() {
  assert.equal(
    rendernode.enabled(),
    true,
    'Render-Node ist deaktiviert. RENDER_NODE_URL und RENDER_NODE_TOKEN muessen in .env gesetzt sein.'
  );

  const { jobId, nodeId } = await rendernode.submit(html, 'draft', testAssets);
  console.log(`Render-Auftrag gestartet: ${jobId} auf ${nodeId}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  let previousStatus = '';
  while (Date.now() < deadline) {
    const info = await rendernode.jobStatus(jobId, nodeId);
    const status = String(info?.status || 'pending');
    if (status !== previousStatus) {
      console.log(`Status: ${status}`);
      previousStatus = status;
    }
    if (status === 'completed') {
      const buffer = await rendernode.download(jobId, nodeId);
      assert.ok(Buffer.isBuffer(buffer), 'Download ist kein Buffer.');
      assert.ok(buffer.length > 50 * 1024, `MP4 ist zu klein: ${buffer.length} Bytes.`);
      console.log(`Live-Test bestanden: ${buffer.length} Bytes.`);
      return;
    }
    if (status === 'failed') {
      throw new Error(`Render fehlgeschlagen: ${info?.error || 'unbekannter Fehler'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Render-Job wurde innerhalb von 8 Minuten nicht fertig.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
