'use strict';

// Export and import of node workflows together with their files (ZIP), and the recovery of files during a JSON
// import. Two parts, both in a private copy of the app in a temp directory (own data, projects and assets
// folders, ephemeral ports); the real data folders and port 3111 are never touched, nothing is paid and
// nothing leaves the machine.
//
//   Part 1  the routes of lib/nodes/routes.js in a private express app with small limits: export.zip and
//           export-info, the round trip with checksums, every refusal of the ZIP import (nothing is left behind:
//           no workflow, no session, no temporary file), the SVG rasterising and the rollback after the
//           workflow was created, JSON import copying files on the same server.
//   Part 2  the real server in the user-management mode: who may copy which file during a JSON import (owner,
//           shared, other people, participants, guests, admins), owner / team / folder of a ZIP import, access
//           to export.zip.

const assert = require('assert/strict');
const crypto = require('crypto');
const express = require('express');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const yauzl = require('yauzl');
const zlib = require('zlib');

const { createIsolatedApp } = require('./support/isolated-app');
const { buildZip } = require('./support/zip-builder');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_B = Buffer.concat([PNG, Buffer.from('second image')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(300, 7)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#c00"/></svg>');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const node = (id, type, params = {}, x = 0, y = 0) => ({ id, type, typeVersion: 1, x, y, params });

/* ---------- small helpers ---------- */

// One HTTP call with full control over the headers and the way the body is sent.
//   body: Buffer; chunks: array of Buffers sent as a chunked body (no content-length);
//   lieLength: announce this content-length and send only the first bytes (the server answers before reading).
function send(port, method, url, { as = null, headers = {}, body = null, chunks = null, lieLength = null } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (as) requestHeaders.Cookie = `uid=${encodeURIComponent(as)}`;
    if (lieLength !== null) requestHeaders['Content-Length'] = String(lieLength);
    else if (body !== null) requestHeaders['Content-Length'] = String(body.length);
    else if (chunks) requestHeaders['Transfer-Encoding'] = 'chunked';
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: requestHeaders }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => {
        const buffer = Buffer.concat(parts);
        let json = null;
        if (/json/.test(String(res.headers['content-type']))) {
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch (_) {
            json = null;
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, buffer, json, text: buffer.toString('utf8') });
        if (lieLength !== null) req.destroy();
      });
    });
    req.on('error', (err) => {
      if (lieLength !== null && err.code === 'ECONNRESET') return;
      reject(err);
    });
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else if (lieLength !== null) {
      req.write((body || Buffer.alloc(0)).subarray(0, 16));
    } else {
      req.end(body);
    }
  });
}

// ZIP buffer -> Map(name -> { data, method, mode }).
function readZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const parts = [];
          stream.on('data', (part) => parts.push(part));
          stream.on('end', () => {
            files.set(entry.fileName, { data: Buffer.concat(parts), method: entry.compressionMethod, mode: (entry.externalFileAttributes >>> 16) & 0o170000 });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

const entriesOf = async (buffer) => [...(await readZip(buffer)).entries()].map(([name, entry]) => ({ name, data: entry.data }));
const jsonOf = (data) => JSON.parse(data.toString('utf8'));

async function waitForServer(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  assert.notEqual(port, 3111);
  return { server, port };
}

/* ---------- part 1: the routes with small limits ---------- */

const LIMITS = { maxUploadBytes: 4096, maxImportZipBytes: 20000, maxImportUnpackedBytes: 12000, maxImportFiles: 5 };

async function part1() {
  const iso = await createIsolatedApp({ active: false, env: { OPENROUTER_API_KEY: '' } });
  const { registerNodeRoutes } = iso.load('lib/nodes/routes');
  const wfStoreModule = iso.load('lib/nodes/workflows-store');
  const wfStore = wfStoreModule.defaultStore;
  const { createEngine } = iso.load('lib/nodes/engine');
  const archive = iso.load('lib/nodes/workflow-archive');
  const sessionStore = iso.load('lib/store');
  const assetsLib = iso.load('lib/nodes/assets');
  const assetsDir = path.join(iso.root, 'assets');
  const projectsDir = path.join(iso.root, 'projects');
  sessionStore.ensureDirs();

  const app = express();
  app.use((req, _res, next) => {
    req.kubleUser = 'tester';
    next();
  });
  app.use(express.json({ limit: '60mb' }));
  registerNodeRoutes(app, { engine: createEngine({ store: wfStore, getConfig: () => ({}) }), store: wfStore, ...LIMITS });
  const { server, port } = await waitForServer(app);
  const call = (method, url, options) => send(port, method, url, options);
  const api = async (method, url, json) => {
    const response = await call(method, url, json === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(json)) });
    return response;
  };
  const upload = async (workflowId, buffer, filename, mime) => {
    const response = await call('POST', `/api/workflows/${workflowId}/uploads`, { headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(filename) }, body: buffer });
    assert.equal(response.status, 200, response.text);
    return response.json.value;
  };
  const fileOf = (value) => assetsLib.assetFilePath(value);

  const snapshot = async () => ({
    workflows: (await wfStore.listWorkflows({})).map((item) => item.id).sort(),
    assets: (await fsp.readdir(assetsDir)).sort(),
    projects: (await fsp.readdir(projectsDir)).sort()
  });
  const importZip = (buffer, query = '', extra = {}) =>
    call('POST', `/api/workflows/import-zip${query}`, { headers: { 'Content-Type': 'application/zip' }, body: buffer, ...extra });
  // A refused import: the answer, and nothing left behind (workflows, sessions, assets, staging folders).
  const refused = async (label, buffer, expected, extra = {}) => {
    const before = await snapshot();
    const response = await importZip(buffer, '', extra);
    assert.equal(response.status, expected.status, `${label}: ${response.status} ${response.text}`);
    assert.equal(response.json.code, expected.code, `${label}: ${response.text}`);
    if (expected.reason) assert.equal(response.json.reason, expected.reason, `${label}: ${response.text}`);
    assert.equal(typeof response.json.error, 'string', label);
    assert.deepEqual(await snapshot(), before, `${label}: nothing is left behind`);
    return response.json;
  };

  try {
    /* ----- a workflow with files ----- */
    const created = (await api('POST', '/api/workflows', { name: 'Coffee ad' })).json.workflow;
    const sessionId = created.sessionId;
    const imgA = await upload(created.id, PNG, 'cover.png', 'image/png');
    const imgB = await upload(created.id, PNG_B, 'Ünïcode name.png', 'image/png');
    const vid = await upload(created.id, MP4, 'clip.mp4', 'video/mp4');
    const unused = await upload(created.id, Buffer.concat([PNG, Buffer.from('unused')]), 'unused.png', 'image/png'); // an upload no node uses
    const resultAsset = await sessionStore.saveAsset(sessionId, { kind: 'image', buffer: Buffer.concat([PNG, Buffer.from('result')]), ext: '.png', prompt: 'a result', cost: null });
    const graph = {
      nodes: [
        node('n1', 'input.image', { asset: imgA }),
        node('n2', 'input.image', { asset: imgB }, 0, 100),
        node('n3', 'input.video', { asset: vid }, 0, 200),
        node('n4', 'input.media_list', { kind: 'image', assets: [imgA, imgB, { type: 'image', missing: true, sessionId, assetId: 'upl-099', file: 'upl-099.png' }] }, 0, 300),
        node('n5', 'input.image', { asset: { type: 'image', missing: true } }, 0, 400),
        node('n6', 'output.result', {}, 300, 0)
      ],
      edges: []
    };
    assert.equal((await api('PUT', `/api/workflows/${created.id}`, { baseRev: 1, graph })).status, 200);
    await wfStore.appendHistory(created.id, 'n6', { variants: [{ image: assetsLib.valueFromLedgerEntry(sessionId, { ...resultAsset, kind: 'image' }) }] });
    const sourceBytes = new Map([[imgA.assetId, PNG], [imgB.assetId, PNG_B], [vid.assetId, MP4]]);
    assert.ok(unused.assetId && resultAsset.id);

    /* ----- export-info ----- */
    const info = await api('GET', `/api/workflows/${created.id}/export-info`);
    assert.equal(info.status, 200, info.text);
    assert.equal(info.json.fileCount, 3, 'three distinct files (the image used twice counts once)');
    assert.equal(info.json.referenceCount, 7);
    assert.equal(info.json.missingCount, 2, 'one marked missing inside the list, one single input marked missing');
    assert.equal(info.json.totalBytes, PNG.length + PNG_B.length + MP4.length);
    assert.ok(info.json.estimatedZipBytes > info.json.totalBytes);
    assert.equal(info.json.exceedsImportSize, false);
    assert.equal(info.json.exceedsImportFiles, false);
    assert.deepEqual(info.json.limits, { maxZipBytes: 500 * 1024 * 1024, maxFiles: 200 });
    assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/export-info')).status, 404);
    assert.equal((await api('GET', '/api/workflows/bad%20id/export-info')).status, 400);
    // The hint for big exports: over 500 MB or 200 files the standard limits of another server would refuse the ZIP.
    const big = archive.describeExport({ files: [], items: [], references: 0, missing: 0, totalBytes: 600 * 1024 * 1024 });
    assert.equal(big.exceedsImportSize, true);
    assert.equal(big.exceedsImportFiles, false);
    assert.equal(archive.describeExport({ files: new Array(201).fill({}), items: [], references: 201, missing: 0, totalBytes: 10 }).exceedsImportFiles, true);

    /* ----- export.zip ----- */
    const exported = await call('GET', `/api/workflows/${created.id}/export.zip`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-type'], /application\/zip/);
    assert.match(exported.headers['content-disposition'], /^attachment; filename="Coffee-ad\.ocd-workflow\.zip"/);
    assert.ok(exported.headers['content-disposition'].includes("filename*=UTF-8''Coffee%20ad.ocd-workflow.zip"));
    const zip = await readZip(exported.buffer);
    assert.deepEqual([...zip.keys()].sort(), ['files/001-cover.png', 'files/002-Unicode-name.png', 'files/003-clip.mp4', 'workflow.json'], 'inputs only: no result, no unused upload');
    for (const name of ['files/001-cover.png', 'files/002-Unicode-name.png', 'files/003-clip.mp4']) assert.equal(zip.get(name).method, 0, `${name} is stored, not compressed again`);
    assert.equal(zip.get('workflow.json').method, 8);
    assert.deepEqual(zip.get('files/001-cover.png').data, PNG);
    assert.deepEqual(zip.get('files/002-Unicode-name.png').data, PNG_B);
    assert.deepEqual(zip.get('files/003-clip.mp4').data, MP4);
    const document = jsonOf(zip.get('workflow.json').data);
    const jsonExport = (await api('GET', `/api/workflows/${created.id}/export`)).json;
    assert.equal(document.format, 'ocd.workflow');
    assert.equal(document.version, 1);
    assert.equal(document.id, undefined);
    assert.equal(document.sessionId, undefined);
    assert.equal(jsonExport.files, undefined, 'the JSON export stays as it was');
    for (const key of ['name', 'description', 'graph', 'app']) assert.deepEqual(document[key], jsonExport[key], `${key} as in the JSON export`);
    assert.deepEqual(document.files, [
      { node: 'n1', param: 'asset', path: 'files/001-cover.png', type: 'image', name: 'cover.png', size: PNG.length },
      { node: 'n2', param: 'asset', path: 'files/002-Unicode-name.png', type: 'image', name: 'Ünïcode name.png', size: PNG_B.length },
      { node: 'n3', param: 'asset', path: 'files/003-clip.mp4', type: 'video', name: 'clip.mp4', size: MP4.length },
      { node: 'n4', param: 'assets', index: 0, path: 'files/001-cover.png', type: 'image', name: 'cover.png', size: PNG.length },
      { node: 'n4', param: 'assets', index: 1, path: 'files/002-Unicode-name.png', type: 'image', name: 'Ünïcode name.png', size: PNG_B.length },
      { node: 'n4', param: 'assets', index: 2, missing: true, type: 'image' },
      { node: 'n5', param: 'asset', missing: true, type: 'image' }
    ]);
    for (const name of zip.keys()) {
      assert.ok(!name.includes('..') && !name.startsWith('/') && !/[\u0000-\u001f\\]/.test(name), `safe name ${name}`);
    }
    assert.equal(zip.get('workflow.json').data.length < 2 * 1024 * 1024, true);

    // A file that is gone from the disk, a pending asset, a foreign session or an invalid id is not packed and stays missing.
    const second = (await api('POST', '/api/workflows', { name: 'Gaps' })).json.workflow;
    const keep = await upload(second.id, PNG, 'keep.png', 'image/png');
    const gone = await upload(second.id, Buffer.concat([PNG, Buffer.from('gone')]), 'gone.png', 'image/png');
    const pending = await sessionStore.reserveAsset(second.sessionId, { kind: 'image', ext: '.png', prompt: 'pending' });
    await fsp.rm(fileOf(gone));
    const gapGraph = {
      nodes: [
        node('n1', 'input.image', { asset: keep }),
        node('n2', 'input.image', { asset: gone }, 0, 100),
        node('n3', 'input.image', { asset: { ...keep, assetId: pending.id, file: pending.file } }, 0, 200),
        node('n4', 'input.image', { asset: { ...keep, assetId: 'bad id!' } }, 0, 300),
        node('n5', 'input.image', { asset: { ...keep, sessionId: sessionId } }, 0, 400)
      ],
      edges: []
    };
    assert.equal((await api('PUT', `/api/workflows/${second.id}`, { baseRev: 1, graph: gapGraph })).status, 200);
    const gapZip = await readZip((await call('GET', `/api/workflows/${second.id}/export.zip`)).buffer);
    assert.deepEqual([...gapZip.keys()].sort(), ['files/001-keep.png', 'workflow.json'], 'only the intact file is packed (n5 names the session of another workflow)');
    assert.deepEqual(jsonOf(gapZip.get('workflow.json').data).files.map((item) => item.missing === true), [false, true, true, true, true]);
    await wfStore.deleteWorkflow(second.id);

    /* ----- round trip ----- */
    const before = await snapshot();
    const folderName = 'Spring campaign';
    const imported = await importZip(exported.buffer, `?folder=${encodeURIComponent(folderName)}&name=${encodeURIComponent('Coffee ad (copy)')}`);
    assert.equal(imported.status, 201, imported.text);
    const copy = imported.json.workflow;
    assert.notEqual(copy.id, created.id);
    assert.notEqual(copy.sessionId, sessionId);
    assert.equal(copy.name, 'Coffee ad (copy)');
    assert.equal(copy.folder, folderName);
    assert.equal(copy.rev, 1);
    assert.equal(copy.createdBy, 'tester');
    assert.deepEqual(imported.json.files, {
      code: 'IMPORT_FILES_PARTIAL',
      total: 7,
      imported: 5,
      missing: 2,
      message: '5 von 7 Dateien übernommen, 2 fehlen.'
    });
    const copyStored = await wfStore.readWorkflow(copy.id);
    const byNode = new Map(copyStored.graph.nodes.map((entry) => [entry.id, entry]));
    for (const [nodeId, source] of [['n1', imgA], ['n2', imgB], ['n3', vid]]) {
      const entry = byNode.get(nodeId).params.asset;
      assert.equal(entry.missing, undefined, `${nodeId} is complete`);
      assert.equal(entry.sessionId, copy.sessionId);
      assert.equal(entry.type, source.type);
      assert.ok(entry.url.startsWith(`/assets/${copy.sessionId}/`));
      assert.equal(sha(await fsp.readFile(fileOf(entry))), sha(sourceBytes.get(source.assetId)), `${nodeId}: same checksum`);
    }
    const list = byNode.get('n4').params.assets;
    assert.equal(list[0].assetId, byNode.get('n1').params.asset.assetId, 'the same file stays one file');
    assert.equal(sha(await fsp.readFile(fileOf(list[1]))), sha(PNG_B));
    assert.equal(list[2].missing, true, 'what was missing stays missing');
    assert.equal(byNode.get('n5').params.asset.missing, true);
    // the graph is otherwise the one that was exported
    assert.deepEqual(copyStored.graph.nodes.map((entry) => [entry.id, entry.type, entry.x, entry.y]), graph.nodes.map((entry) => [entry.id, entry.type, entry.x, entry.y]));
    const copyAssets = (await api('GET', `/api/workflows/${copy.id}/assets`)).json.assets;
    assert.equal(copyAssets.length, 3, 'three files in the new session, nothing else');
    const copyLedger = await sessionStore.readLedger(copy.sessionId);
    assert.ok(copyLedger.every((entry) => entry.kind === 'upload' && !entry.pending));
    assert.deepEqual(copyLedger.map((entry) => entry.prompt).sort(), ['clip.mp4', 'cover.png', 'Ünïcode name.png']);
    const after = await snapshot();
    assert.equal(after.workflows.length, before.workflows.length + 1);
    assert.deepEqual((await fsp.readdir(path.join(assetsDir, copy.sessionId))).filter((name) => name.startsWith('.')), [], 'no scratch folder left in the new session');
    assert.deepEqual(after.assets.filter((name) => name.startsWith('.import-zip-')), [], 'no staging folder left');
    // the source is untouched
    assert.equal((await api('GET', `/api/workflows/${created.id}/assets`)).json.assets.length, 5, '4 uploads and 1 result');
    // the copy runs: it can be exported again and gives the same files
    const again = await readZip((await call('GET', `/api/workflows/${copy.id}/export.zip`)).buffer);
    assert.deepEqual([...again.keys()].sort(), [...zip.keys()].sort());
    assert.deepEqual(again.get('files/003-clip.mp4').data, MP4);
    // a ZIP without any files (a workflow with text only) works as well and says nothing about files
    const textFlow = (await api('POST', '/api/workflows', { name: 'Text only', document: { format: 'ocd.workflow', version: 1, name: 'Text only', graph: { nodes: [node('n1', 'input.text', { text: 'hi' })], edges: [] } } })).json.workflow;
    const textZip = await call('GET', `/api/workflows/${textFlow.id}/export.zip`);
    assert.deepEqual([...(await readZip(textZip.buffer)).keys()], ['workflow.json']);
    const textImport = await importZip(textZip.buffer);
    assert.equal(textImport.status, 201, textImport.text);
    assert.deepEqual(textImport.json.files, { code: 'IMPORT_FILES_NONE', total: 0, imported: 0, missing: 0, message: null });

    /* ----- the ZIP import refuses, and leaves nothing behind ----- */
    const file = (name, data, extra = {}) => ({ name, data, ...extra });
    const baseGraph = (assetParams = {}) => ({
      nodes: [node('n1', 'input.image', { asset: { type: 'image', sessionId: 'sess-x', assetId: 'upl-001', file: 'upl-001.png', url: '/assets/sess-x/upl-001.png', ...assetParams } })],
      edges: []
    });
    const docOf = (files, extra = {}) => ({ format: 'ocd.workflow', version: 1, name: 'Crafted', description: '', graph: baseGraph(), app: {}, files, ...extra });
    const listing = (filePath = 'files/001-a.png', extra = {}) => ({ node: 'n1', param: 'asset', path: filePath, type: 'image', name: 'a.png', size: PNG.length, ...extra });
    const crafted = (document, entries = [file('files/001-a.png', PNG)], zipExtra = []) =>
      buildZip([file('workflow.json', typeof document === 'string' ? document : JSON.stringify(document)), ...entries, ...zipExtra]);

    const wantImported = (json, count) => assert.equal(json.files.imported, count, JSON.stringify(json.files));

    // the crafted baseline is accepted (so each refusal below is about the one thing that was changed)
    const baseline = await importZip(crafted(docOf([listing()])));
    assert.equal(baseline.status, 201, baseline.text);
    assert.deepEqual(baseline.json.files, { code: 'IMPORT_FILES_ALL', total: 1, imported: 1, missing: 0, message: '1 von 1 Datei übernommen.' });
    await wfStore.deleteWorkflow(baseline.json.workflow.id);

    // too large: announced in the header (nothing is read), and while streaming (no content-length)
    const hugeBody = Buffer.alloc(LIMITS.maxImportZipBytes + 100, 1);
    const header = await refused('header too large', hugeBody, { status: 413, code: 'TOO_LARGE', reason: 'archive' }, { lieLength: LIMITS.maxImportZipBytes + 100 });
    assert.equal(header.params.limitBytes, LIMITS.maxImportZipBytes);
    assert.match(header.error, /grösser als/);
    await refused('streamed too large', null, { status: 413, code: 'TOO_LARGE', reason: 'archive' }, {
      body: null,
      chunks: [hugeBody.subarray(0, 9000), hugeBody.subarray(9000, 18000), hugeBody.subarray(18000)]
    });
    // too many files (limit 5 in this test)
    const six = Array.from({ length: 6 }, (_, index) => file(`files/00${index + 1}-a.png`, PNG));
    const sixDoc = docOf(six.map((entry) => listing(entry.name)));
    const many = await refused('too many files', crafted(sixDoc, six), { status: 413, code: 'TOO_MANY_FILES' });
    assert.equal(many.params.maxFiles, 5);
    const manyNodes = { nodes: Array.from({ length: 5 }, (_, index) => node(`n${index + 1}`, 'input.image', { asset: { type: 'image', sessionId: 'sess-x', assetId: `upl-00${index + 1}`, file: `upl-00${index + 1}.png` } })), edges: [] };
    const five = Array.from({ length: 5 }, (_, index) => file(`files/00${index + 1}-a.png`, PNG));
    const fiveDoc = docOf(five.map((entry, index) => listing(entry.name, { node: `n${index + 1}` })), { graph: manyNodes });
    const fiveImport = await importZip(crafted(fiveDoc, five));
    assert.equal(fiveImport.status, 201, `exactly the limit is fine: ${fiveImport.text}`);
    wantImported(fiveImport.json, 5);
    await wfStore.deleteWorkflow(fiveImport.json.workflow.id);
    // unpacked too large: each file within its limit, the sum over the total limit
    const bulk = Array.from({ length: 4 }, (_, index) => file(`files/00${index + 1}-a.png`, Buffer.alloc(3500, index + 1)));
    await refused('sum too large', crafted(docOf(bulk.map((entry) => listing(entry.name))), bulk), { status: 413, code: 'TOO_LARGE', reason: 'unpacked' });
    await refused('file too large', crafted(docOf([listing()]), [file('files/001-a.png', Buffer.alloc(4097, 3), { method: 8 })]), { status: 413, code: 'TOO_LARGE', reason: 'file' });
    // unsafe paths
    for (const [label, name] of [['dot dot', 'files/../evil.png'], ['dot dot first', '../evil.png'], ['absolute', '/etc/evil.png'], ['drive letter', 'C:/evil.png'], ['backslash', 'files\\evil.png'], ['double slash', 'files//evil.png'], ['control', 'files/evil\u0001.png']]) {
      await refused(`path: ${label}`, crafted(docOf([listing(name)]), [file(name, PNG)]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'UNSAFE_PATH' });
    }
    await refused('path in the directory only', crafted(docOf([listing('files/../x.png')])), { status: 400, code: 'INVALID_ARCHIVE' });
    // an entry that is not in the directory
    const unlisted = await refused('not in the directory', crafted(docOf([listing()]), [file('files/001-a.png', PNG)], [file('files/002-extra.png', PNG)]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'UNLISTED_ENTRY' });
    assert.equal(unlisted.params.path, 'files/002-extra.png');
    await refused('stray file next to workflow.json', crafted(docOf([listing()]), [file('files/001-a.png', PNG)], [file('notes.txt', Buffer.from('x'))]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'UNLISTED_ENTRY' });
    await refused('listed but absent', crafted(docOf([listing()]), []), { status: 400, code: 'INVALID_ARCHIVE', reason: 'MISSING_ENTRY' });
    // wrong type
    for (const [label, name] of [['text', 'files/001-a.txt'], ['executable', 'files/001-a.exe'], ['no extension', 'files/001-a'], ['html', 'files/001-a.html']]) {
      await refused(`type: ${label}`, crafted(docOf([listing(name)]), [file(name, PNG)]), { status: 415, code: 'UNSUPPORTED_MEDIA' });
    }
    await refused('declared type differs', crafted(docOf([listing('files/001-a.png', { type: 'video' })])), { status: 415, code: 'UNSUPPORTED_MEDIA' });
    // the file must fit the node it feeds (the type of the file is right, but not for this node)
    const mp4Item = (extra = {}) => ({ node: 'n1', param: 'asset', path: 'files/001-a.mp4', type: 'video', name: 'a.mp4', size: MP4.length, ...extra });
    const mismatch = await refused('video for an image node', crafted(docOf([mp4Item()]), [file('files/001-a.mp4', MP4)]), { status: 415, code: 'UNSUPPORTED_MEDIA', reason: 'MISMATCH' });
    assert.deepEqual([mismatch.params.expected, mismatch.params.found], ['image', 'video']);
    const listDoc = (kind, items) => docOf(items, { graph: { nodes: [node('n1', 'input.media_list', { kind, assets: [{ type: kind, sessionId: 'sess-x', assetId: 'upl-001', file: 'upl-001.png' }] })], edges: [] } });
    const listItem = (extra) => mp4Item({ param: 'assets', index: 0, ...extra });
    await refused('video file in an image list', crafted(listDoc('image', [listItem()]), [file('files/001-a.mp4', MP4)]), { status: 415, code: 'UNSUPPORTED_MEDIA', reason: 'MISMATCH' });
    await refused('image file in a video list', crafted(listDoc('video', [listItem({ path: 'files/001-a.png', type: 'image', size: PNG.length })]), [file('files/001-a.png', PNG)]), { status: 415, code: 'UNSUPPORTED_MEDIA', reason: 'MISMATCH' });
    const videoList = await importZip(crafted(listDoc('video', [listItem()]), [file('files/001-a.mp4', MP4)]));
    assert.equal(videoList.status, 201, `a video list takes a video: ${videoList.text}`);
    wantImported(videoList.json, 1);
    await wfStore.deleteWorkflow(videoList.json.workflow.id);
    const twoKinds = docOf([listing(), { node: 'n2', param: 'asset', path: 'files/001-a.png', type: 'image', name: 'a.png', size: PNG.length }], {
      graph: { nodes: [node('n1', 'input.image', { asset: { type: 'image', sessionId: 'sess-x', assetId: 'upl-001', file: 'upl-001.png' } }), node('n2', 'input.video', { asset: { type: 'video', sessionId: 'sess-x', assetId: 'upl-002', file: 'upl-002.mp4' } }, 0, 100)], edges: [] }
    });
    await refused('one image for an image and a video node', crafted(twoKinds), { status: 415, code: 'UNSUPPORTED_MEDIA', reason: 'MISMATCH' });
    // lying sizes (zip bombs)
    const bomb = Buffer.alloc(3 * 1024 * 1024, 0);
    const bombZip = crafted(docOf([listing()]), [file('files/001-a.png', bomb, { method: 8, uncompressedSize: 100 })]);
    assert.ok(bombZip.length < 20000, 'the bomb itself is small');
    await refused('bomb: announces 100, delivers 3 MB', bombZip, { status: 400, code: 'INVALID_ARCHIVE', reason: 'SIZE_MISMATCH' });
    await refused('bomb: announces 4000, delivers 3 MB', crafted(docOf([listing()]), [file('files/001-a.png', bomb, { method: 8, uncompressedSize: 4000 })]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'SIZE_MISMATCH' });
    await refused('stored: more than announced', crafted(docOf([listing()]), [file('files/001-a.png', Buffer.alloc(500, 1), { uncompressedSize: 100, compressedSize: 500 })]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'SIZE_MISMATCH' });
    await refused('fewer than announced', crafted(docOf([listing()]), [file('files/001-a.png', Buffer.alloc(50, 1), { method: 8, uncompressedSize: 300 })]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'SIZE_MISMATCH' });
    await refused('workflow.json over 2 MB', buildZip([file('workflow.json', Buffer.alloc(3 * 1024 * 1024, 32), { method: 8 })]), { status: 413, code: 'TOO_LARGE', reason: 'workflow' });
    await refused('workflow.json announces little, delivers much', buildZip([file('workflow.json', Buffer.alloc(3 * 1024 * 1024, 32), { method: 8, uncompressedSize: 200 })]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'SIZE_MISMATCH' });
    // broken archives
    const good = crafted(docOf([listing()]));
    await refused('not a zip (JSON)', Buffer.from(JSON.stringify(docOf([]))), { status: 400, code: 'INVALID_ARCHIVE', reason: 'NOT_A_ZIP' });
    await refused('random bytes', crypto.randomBytes(900), { status: 400, code: 'INVALID_ARCHIVE', reason: 'NOT_A_ZIP' });
    await refused('truncated', good.subarray(0, good.length - 30), { status: 400, code: 'INVALID_ARCHIVE', reason: 'NOT_A_ZIP' });
    await refused('empty body', Buffer.alloc(0), { status: 400, code: 'INVALID_ARCHIVE', reason: 'NOT_A_ZIP' });
    const damaged = Buffer.from(good);
    damaged.fill(0xff, damaged.length - 60, damaged.length - 40); // the central directory
    await refused('damaged directory', damaged, { status: 400, code: 'INVALID_ARCHIVE' });
    await refused('deflate data damaged', (() => {
      const packed = crafted(docOf([listing()]), [file('files/001-a.png', Buffer.alloc(2000, 5), { method: 8 })]);
      const position = packed.indexOf(zlib.deflateRawSync(Buffer.alloc(2000, 5)));
      packed.fill(0xff, position, position + 6);
      return packed;
    })(), { status: 400, code: 'INVALID_ARCHIVE', reason: 'CORRUPT_ENTRY' });
    // links, duplicates, encryption, no workflow.json
    await refused('symbolic link', crafted(docOf([listing()]), [file('files/001-a.png', Buffer.from('target.png'), { mode: 0o120777 })]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'LINK_ENTRY' });
    await refused('duplicate entry', crafted(docOf([listing()]), [file('files/001-a.png', PNG), file('files/001-a.png', PNG_B)]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'DUPLICATE_ENTRY' });
    await refused('two workflow.json', buildZip([file('workflow.json', JSON.stringify(docOf([]))), file('workflow.json', JSON.stringify(docOf([])))]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'DUPLICATE_ENTRY' });
    await refused('encrypted', crafted(docOf([listing()]), [file('files/001-a.png', PNG, { flags: 1 })]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'UNSUPPORTED_COMPRESSION' });
    await refused('no workflow.json', buildZip([file('files/001-a.png', PNG)]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'NO_WORKFLOW_JSON' });
    await refused('workflow.json in a folder', buildZip([file('data/workflow.json', JSON.stringify(docOf([]))), file('files/001-a.png', PNG)]), { status: 400, code: 'INVALID_ARCHIVE' });
    await refused('empty file', crafted(docOf([listing()]), [file('files/001-a.png', Buffer.alloc(0))]), { status: 400, code: 'INVALID_ARCHIVE', reason: 'EMPTY_FILE' });
    // invalid workflow.json
    await refused('workflow.json is not JSON', buildZip([file('workflow.json', '{ not json')]), { status: 400, code: 'INVALID_WORKFLOW', reason: 'NOT_JSON' });
    await refused('workflow.json is a list', buildZip([file('workflow.json', '[]')]), { status: 400, code: 'INVALID_WORKFLOW' });
    await refused('wrong format', crafted(docOf([listing()], { format: 'other' })), { status: 400, code: 'INVALID_WORKFLOW', reason: 'INVALID_DOCUMENT' });
    await refused('newer version', crafted(docOf([listing()], { version: 99 })), { status: 400, code: 'INVALID_WORKFLOW' });
    const cyclic = docOf([listing()]);
    cyclic.graph.nodes.push(node('n2', 'text.template'), node('n3', 'text.template'));
    cyclic.graph.edges = [
      { id: 'e1', from: { node: 'n2', port: 'text' }, to: { node: 'n3', port: 'a' } },
      { id: 'e2', from: { node: 'n3', port: 'text' }, to: { node: 'n2', port: 'a' } }
    ];
    await refused('cycle', crafted(cyclic), { status: 400, code: 'INVALID_WORKFLOW' });
    const dangling = docOf([listing()]);
    dangling.graph.edges = [{ id: 'e1', from: { node: 'n1', port: 'image' }, to: { node: 'zz', port: 'in' } }];
    await refused('dangling edge', crafted(dangling), { status: 400, code: 'INVALID_WORKFLOW' });
    // a broken directory
    for (const [label, files] of [
      ['not a list', { node: 'n1' }],
      ['unknown node', [listing('files/001-a.png', { node: 'zz' })]],
      ['unknown param', [listing('files/001-a.png', { param: 'other' })]],
      ['asset with an index', [listing('files/001-a.png', { index: 0 })]],
      ['assets without index', [listing('files/001-a.png', { param: 'assets' })]],
      ['same input twice', [listing(), listing()]],
      ['path outside files/', [listing('other/001-a.png')]],
      ['negative size', [listing('files/001-a.png', { size: -4 })]],
      ['not an object', ['files/001-a.png']]
    ]) {
      await refused(`directory: ${label}`, crafted(docOf(files)), { status: 400, code: 'INVALID_ARCHIVE' });
    }
    await refused('directory points to a non-media param', crafted(docOf([listing()], { graph: { nodes: [node('n1', 'input.text', { text: 'x' })], edges: [] } })), { status: 400, code: 'INVALID_ARCHIVE', reason: 'BAD_DIRECTORY' });

    // a directory item without path, or marked missing: nothing to unpack, the input stays missing
    const noFiles = await importZip(crafted(docOf([{ node: 'n1', param: 'asset', missing: true }]), []));
    assert.equal(noFiles.status, 201, noFiles.text);
    assert.equal(noFiles.json.files.code, 'IMPORT_FILES_MISSING');
    assert.equal(noFiles.json.files.message, '0 von 1 Datei übernommen, 1 fehlt.');
    await wfStore.deleteWorkflow(noFiles.json.workflow.id);

    // the file name in the directory is only a label: control characters and paths are cut off
    const named = await importZip(crafted(docOf([listing('files/001-a.png', { name: 'x/../\u0001ev\nil.png' })])));
    assert.equal(named.status, 201, named.text);
    assert.deepEqual((await sessionStore.readLedger(named.json.workflow.sessionId)).map((entry) => entry.prompt), ['evil.png']);
    await wfStore.deleteWorkflow(named.json.workflow.id);

    // SVG: rasterised like an upload, the PNG is what the node gets
    const svgDoc = docOf([listing('files/001-logo.svg', { name: 'logo.svg' })]);
    const svgImport = await importZip(crafted(svgDoc, [file('files/001-logo.svg', SVG)]));
    assert.equal(svgImport.status, 201, svgImport.text);
    const svgStored = await wfStore.readWorkflow(svgImport.json.workflow.id);
    const svgParam = svgStored.graph.nodes[0].params.asset;
    assert.equal(path.extname(svgParam.file), '.png');
    assert.equal((await fsp.readFile(fileOf(svgParam))).subarray(1, 4).toString(), 'PNG');
    await wfStore.deleteWorkflow(svgImport.json.workflow.id);
    // an SVG that cannot be rasterised: the workflow exists for a moment and is removed again
    await refused('unreadable SVG (rolled back)', crafted(svgDoc, [file('files/001-logo.svg', Buffer.from('<svg/>'))]), { status: 415, code: 'UNSUPPORTED_MEDIA', reason: 'UNREADABLE' });

    // The body is the raw ZIP. A JSON content type used to hang the request (the body parser of the app reads such a
    // body first and nothing is left to read); now it is refused up front, before a staging folder exists.
    const jsonBody = Buffer.from('{"document":{}}');
    for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'image/png']) {
      const outcome = await Promise.race([
        refused(`content type ${type}`, type === 'application/json' ? jsonBody : good, { status: 415, code: 'UNSUPPORTED_MEDIA', reason: 'CONTENT_TYPE' }, { headers: { 'Content-Type': type } }),
        new Promise((resolve) => setTimeout(() => resolve('HANG'), 6000))
      ]);
      assert.notEqual(outcome, 'HANG', `${type}: the request is answered`);
    }
    for (const type of ['application/octet-stream', 'application/x-zip-compressed', 'application/zip; charset=binary']) {
      const accepted = await importZip(good, '', { headers: { 'Content-Type': type } });
      assert.equal(accepted.status, 201, `${type}: ${accepted.text}`);
      await wfStore.deleteWorkflow(accepted.json.workflow.id);
    }
    // The same on the upload route: a JSON body is consumed by the parser before the handler runs. The handler must
    // notice and answer instead of waiting for data that never comes; its scratch folder is removed.
    const hangBefore = await snapshot();
    const hang = await Promise.race([
      call('POST', `/api/workflows/${created.id}/uploads`, { headers: { 'Content-Type': 'application/json', 'X-Filename': 'a.png' }, body: jsonBody }),
      new Promise((resolve) => setTimeout(() => resolve('HANG'), 6000))
    ]);
    assert.notEqual(hang, 'HANG', 'an upload with a JSON content type is answered');
    assert.equal(hang.status, 400, hang.text);
    assert.equal(hang.json.code, 'INVALID_REQUEST');
    assert.deepEqual((await fsp.readdir(path.join(assetsDir, sessionId))).filter((name) => name.startsWith('.')), [], 'no scratch folder left in the session');
    assert.deepEqual(await snapshot(), hangBefore);

    // folder and name checks happen before the body is read
    const badFolder = await importZip(good, `?folder=${encodeURIComponent('x'.repeat(61))}`);
    assert.equal(badFolder.status, 400);
    assert.equal(badFolder.json.code, 'INVALID_REQUEST');
    const arrayFolder = await importZip(good, '?folder=a&folder=b');
    assert.equal(arrayFolder.status, 400);

    // a staging folder a crash left behind is swept on the next import (and a fresh one is left alone)
    const stale = path.join(assetsDir, '.import-zip-stale1');
    const fresh = path.join(assetsDir, '.import-zip-fresh1');
    await fsp.mkdir(stale);
    await fsp.mkdir(fresh);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);
    const sweepRun = await importZip(good);
    assert.equal(sweepRun.status, 201, sweepRun.text);
    await wfStore.deleteWorkflow(sweepRun.json.workflow.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual((await fsp.readdir(assetsDir)).filter((name) => name.startsWith('.import-zip-')), ['.import-zip-fresh1']);
    await fsp.rm(fresh, { recursive: true });

    // a client that hangs up in the middle of the upload leaves nothing either
    const abortBefore = await snapshot();
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/workflows/import-zip', headers: { 'Content-Type': 'application/zip', 'Content-Length': '9000' } });
      req.on('error', () => {});
      req.write(good.subarray(0, 100));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await snapshot(), abortBefore, 'an interrupted upload leaves nothing behind');

    /* ----- limits of the archive library itself ----- */
    assert.equal(archive.DEFAULT_LIMITS.maxUnpackedBytes, 2 * archive.DEFAULT_LIMITS.maxFileBytes, 'the unpacked sum is twice the file limit (1000 MB), as documented');
    assert.equal(archive.DEFAULT_LIMITS.maxUnpackedBytes, 1000 * 1024 * 1024);
    const MB = 1024 * 1024;
    const unitDir = await fsp.mkdtemp(path.join(iso.root, 'unit-'));
    const classifyImage = (zipPath) => ({ ext: path.extname(zipPath), type: 'image' });
    const unitPrepare = async (buffer, limits) => {
      const zipFile = path.join(unitDir, 'in.zip');
      await fsp.writeFile(zipFile, buffer);
      const stagingDir = await fsp.mkdtemp(path.join(unitDir, 's-'));
      return archive.prepareImport(zipFile, stagingDir, { classify: classifyImage, registry: iso.load('lib/nodes/registry').registry, ...(limits ? { limits } : {}) });
    };
    const bigLimits = { ...archive.DEFAULT_LIMITS, maxFileBytes: 50 * MB, maxUnpackedBytes: 100 * MB, maxZipBytes: 50 * MB };
    // A small ZIP that unpacks to a lot: honest sizes, but a deflate ratio no photo, video or audio file has.
    const zeros = Buffer.alloc(8 * MB, 0);
    const ratioZip = crafted(docOf([listing('files/001-a.png', { size: zeros.length })]), [file('files/001-a.png', zeros, { method: 8 })]);
    assert.ok(ratioZip.length < 64 * 1024, `the ZIP is small (${ratioZip.length} bytes) for ${zeros.length} bytes unpacked`);
    await assert.rejects(unitPrepare(ratioZip, bigLimits), (err) => err.code === 'INVALID_ARCHIVE' && err.reason === 'RATIO' && err.params.path === 'files/001-a.png');
    // the same ZIP is fine when the ratio rule is relaxed, and a stored (or hardly compressible) file of that size is fine anyway
    const relaxed = await unitPrepare(ratioZip, { ...bigLimits, maxRatio: 1e9 });
    assert.equal(relaxed.files[0].size, zeros.length);
    const noisy = crypto.randomBytes(2 * MB);
    const noisyZip = crafted(docOf([listing('files/001-a.png', { size: noisy.length })]), [file('files/001-a.png', noisy, { method: 8 })]);
    assert.equal((await unitPrepare(noisyZip, bigLimits)).files[0].size, noisy.length);
    // under the floor the ratio is not looked at (the sum limit covers small files)
    const smallZeros = crafted(docOf([listing('files/001-a.png', { size: 512 * 1024 })]), [file('files/001-a.png', Buffer.alloc(512 * 1024, 0), { method: 8 })]);
    assert.equal((await unitPrepare(smallZeros, bigLimits)).files.length, 1);
    // called without limits, the library uses its own defaults (and fills gaps in partial limits)
    assert.equal((await unitPrepare(crafted(docOf([listing()])))).files.length, 1);
    assert.equal((await unitPrepare(crafted(docOf([listing()])), { maxFiles: 10 })).files.length, 1);
    await fsp.rm(unitDir, { recursive: true, force: true });

    /* ----- JSON import brings files back on the same server ----- */
    const jsonImport = await api('POST', '/api/workflows/import', { document: jsonExport });
    assert.equal(jsonImport.status, 201, jsonImport.text);
    assert.deepEqual(jsonImport.json.files, { code: 'IMPORT_FILES_PARTIAL', total: 7, imported: 5, missing: 2, message: '5 von 7 Dateien übernommen, 2 fehlen.' });
    const jsonCopy = await wfStore.readWorkflow(jsonImport.json.workflow.id);
    assert.equal(jsonCopy.graph.nodes[0].params.asset.sessionId, jsonCopy.sessionId);
    assert.equal(sha(await fsp.readFile(fileOf(jsonCopy.graph.nodes[2].params.asset))), sha(MP4));
    assert.equal(jsonCopy.graph.nodes[4].params.asset.missing, true);
    assert.equal((await sessionStore.readLedger(jsonCopy.sessionId)).length, 3);

    // The file stays missing when the source cannot be used any more.
    const refDoc = (param) => ({ ...jsonExport, graph: { nodes: [node('n1', 'input.image', { asset: param })], edges: [] } });
    const importRef = async (param) => (await api('POST', '/api/workflows/import', { document: refDoc(param) })).json;
    const wantMissing = async (label, param) => {
      const result = await importRef(param);
      assert.equal(result.files.imported, 0, label);
      assert.equal(result.files.code, 'IMPORT_FILES_MISSING', label);
      const stored2 = await wfStore.readWorkflow(result.workflow.id);
      assert.equal(stored2.graph.nodes[0].params.asset.missing, true, label);
      assert.equal((await sessionStore.readLedger(stored2.sessionId)).length, 0, `${label}: nothing copied`);
      await wfStore.deleteWorkflow(result.workflow.id);
    };
    await wantMissing('invented session', { ...imgA, sessionId: 'ses-0000000000ab' });
    assert.equal((await fsp.readdir(assetsDir)).includes('ses-0000000000ab'), false, 'no folder for an invented session');
    await wantMissing('unknown asset', { ...imgA, assetId: 'upl-777' });
    await wantMissing('no session in the reference', { type: 'image', assetId: imgA.assetId, file: imgA.file });
    await wantMissing('invalid ids', { ...imgA, sessionId: '../etc', assetId: 'x' });
    const pendingMain = await sessionStore.reserveAsset(sessionId, { kind: 'upload', ext: '.png', prompt: 'pending' });
    await wantMissing('pending asset', { ...imgA, assetId: pendingMain.id, file: pendingMain.file });
    const goneMain = await upload(created.id, Buffer.concat([PNG, Buffer.from('gone')]), 'gone.png', 'image/png');
    await fsp.rm(fileOf(goneMain));
    await wantMissing('file gone from the disk', goneMain);
    const notMedia = await sessionStore.saveAsset(sessionId, { kind: 'upload', buffer: Buffer.from('hello'), ext: '.txt', prompt: 'note.txt', cost: null });
    await wantMissing('not an image, video or audio', { ...imgA, assetId: notMedia.id, file: notMedia.file });
    // a source that was deleted
    const doomed = (await api('POST', '/api/workflows', { name: 'Doomed' })).json.workflow;
    const doomedFile = await upload(doomed.id, PNG, 'doomed.png', 'image/png');
    await api('DELETE', `/api/workflows/${doomed.id}`);
    await wantMissing('deleted source', doomedFile);
    // A video does not belong into an image node, whoever may see it: the reference stays missing, nothing is copied.
    await wantMissing('video in an image node', vid);
    const kindDoc = (kind, assetsList) => ({ ...jsonExport, graph: { nodes: [node('n1', 'input.media_list', { kind, assets: assetsList })], edges: [] } });
    const videoListImport = (await api('POST', '/api/workflows/import', { document: kindDoc('video', [vid, imgA]) })).json;
    assert.equal(videoListImport.files.imported, 1, 'only the video comes into a list of videos');
    const videoListStored = await wfStore.readWorkflow(videoListImport.workflow.id);
    assert.equal(videoListStored.graph.nodes[0].params.assets[0].type, 'video');
    assert.equal(videoListStored.graph.nodes[0].params.assets[1].missing, true);
    assert.equal((await sessionStore.readLedger(videoListStored.sessionId)).length, 1);
    await wfStore.deleteWorkflow(videoListImport.workflow.id);
    const imageListImport = (await api('POST', '/api/workflows/import', { document: kindDoc('image', [vid, imgA]) })).json;
    assert.equal(imageListImport.files.imported, 1, 'only the image comes into a list of images');
    assert.equal((await wfStore.readWorkflow(imageListImport.workflow.id)).graph.nodes[0].params.assets[0].missing, true);
    await wfStore.deleteWorkflow(imageListImport.workflow.id);

    /* ----- the routes are where they should be ----- */
    assert.equal((await api('GET', '/api/workflows/wf-does-not-exist/export.zip')).status, 404);
    assert.equal((await api('GET', '/api/workflows/bad%20id/export.zip')).status, 400);
    assert.equal((await api('POST', '/api/workflows/import-zip')).status, 400, 'an empty body is not a ZIP');
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await iso.cleanup();
  }
}

/* ---------- part 2: the real server with user management ---------- */

const ADMIN = 'admin@example.com';
const ALICE = 'alice@staff.example.com';
const BOB = 'bob@staff.example.com';
const CAROL = 'carol@staff.example.com';
const P1 = 'p1@gmail.example';
const P2 = 'p2@gmail.example';
const P3 = 'p3@gmail.example';
const GUEST = 'alumni@gmail.example';

async function part2() {
  const iso = await createIsolatedApp({
    env: { ADMIN_EMAILS: ADMIN, INTERNAL_EMAIL_DOMAINS: 'staff.example.com', OPENROUTER_API_KEY: '' }
  });
  await iso.listen();
  const port = iso.port;
  assert.notEqual(port, 3111);
  const teams = iso.load('lib/teams').defaultStore;
  const wfStore = iso.load('lib/nodes/workflows-store').defaultStore;
  const sessionStore = iso.load('lib/store');
  const assetsLib = iso.load('lib/nodes/assets');
  const assetsDir = path.join(iso.root, 'assets');
  const call = (method, url, options) => send(port, method, url, options);
  const api = (method, url, as, json) =>
    call(method, url, json === undefined ? { as } : { as, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(json)) });
  const fileOf = (value) => assetsLib.assetFilePath(value);

  try {
    const team = teams.createTeam({ name: 'Course A', budgetUsd: 5 });
    teams.addMembers(team.id, [P1, P2]);
    const otherTeam = teams.createTeam({ name: 'Course B', budgetUsd: 5 });
    teams.addMembers(otherTeam.id, [P3]);
    for (const email of [ALICE, BOB, CAROL, ADMIN]) assert.equal((await api('GET', '/api/me', email)).status, 200); // seen once: on the team list

    // A workflow of `owner` with one image and one video.
    const makeFlow = async (owner, name, folder) => {
      const created = await api('POST', '/api/workflows', owner, { name, ...(folder ? { folder } : {}) });
      assert.equal(created.status, 201, created.text);
      const flow = created.json.workflow;
      const uploadFile = async (buffer, filename, mime) => {
        const response = await call('POST', `/api/workflows/${flow.id}/uploads`, { as: owner, headers: { 'Content-Type': mime, 'X-Filename': filename }, body: buffer });
        assert.equal(response.status, 200, response.text);
        return response.json.value;
      };
      const image = await uploadFile(Buffer.concat([PNG, Buffer.from(name)]), 'cover.png', 'image/png');
      const video = await uploadFile(Buffer.concat([MP4, Buffer.from(name)]), 'clip.mp4', 'video/mp4');
      const graph = { nodes: [node('n1', 'input.image', { asset: image }), node('n2', 'input.video', { asset: video }, 0, 100)], edges: [] };
      assert.equal((await api('PUT', `/api/workflows/${flow.id}`, owner, { baseRev: 1, graph })).status, 200);
      return { flow, image, video, sessionId: flow.sessionId };
    };
    const jsonOfFlow = async (owner, flow) => (await api('GET', `/api/workflows/${flow.id}/export`, owner)).json;
    // Imports a JSON document as `who`; returns the answer and how many of the two files came along.
    const importJson = async (who, document, extra = {}) => {
      const response = await api('POST', '/api/workflows/import', who, { document, ...extra });
      assert.equal(response.status, 201, response.text);
      return response.json;
    };
    const wantFiles = (result, imported, total = 2) => {
      assert.equal(result.files.total, total);
      assert.equal(result.files.imported, imported, JSON.stringify(result.files));
      assert.equal(result.files.missing, total - imported);
      assert.equal(result.files.code, imported === total ? 'IMPORT_FILES_ALL' : imported === 0 ? 'IMPORT_FILES_MISSING' : 'IMPORT_FILES_PARTIAL');
    };

    /* ----- JSON import: internal people ----- */
    const alice = await makeFlow(ALICE, 'Alice flow');
    const aliceJson = await jsonOfFlow(ALICE, alice.flow);
    let result = await importJson(ALICE, aliceJson, { name: 'Alice copy' });
    wantFiles(result, 2); // the owner
    assert.equal(result.workflow.owner, ALICE);
    const aliceCopy = await wfStore.readWorkflow(result.workflow.id);
    assert.equal(sha(await fsp.readFile(fileOf(aliceCopy.graph.nodes[1].params.asset))), sha(Buffer.concat([MP4, Buffer.from('Alice flow')])));
    assert.notEqual(aliceCopy.graph.nodes[0].params.asset.sessionId, alice.sessionId);

    result = await importJson(BOB, aliceJson);
    wantFiles(result, 0); // somebody else, not shared
    assert.equal((await wfStore.readWorkflow(result.workflow.id)).graph.nodes[0].params.asset.missing, true);
    assert.equal((await sessionStore.readLedger((await wfStore.readWorkflow(result.workflow.id)).sessionId)).length, 0);
    assert.equal((await api('POST', '/api/workflows/import', null, { document: aliceJson })).status, 401, 'an unidentified caller does not import at all');

    assert.equal((await api('PATCH', `/api/workflows/${alice.flow.id}/share`, ALICE, { shareMode: 'specific', sharedWith: [BOB] })).status, 200);
    result = await importJson(BOB, aliceJson);
    wantFiles(result, 2); // shared with Bob
    assert.equal(result.workflow.owner, BOB, 'the copy belongs to the person who imports');
    assert.equal((await api('GET', `/api/workflows/${result.workflow.id}`, ALICE)).status, 404, 'and is private');
    const bobCopy = await wfStore.readWorkflow(result.workflow.id);
    const bobAsset = bobCopy.graph.nodes[0].params.asset;
    assert.equal((await call('GET', bobAsset.url, { as: BOB })).status, 200, 'Bob sees his copy of the file');
    assert.equal((await call('GET', bobAsset.url, { as: CAROL })).status, 404);
    result = await importJson(CAROL, aliceJson);
    wantFiles(result, 0); // shared with Bob only

    assert.equal((await api('PATCH', `/api/workflows/${alice.flow.id}/share`, ALICE, { shareMode: 'team' })).status, 200);
    result = await importJson(CAROL, aliceJson);
    wantFiles(result, 2); // the whole team
    // a participant or guest never gets to see an internal workflow, shared with the team or not
    result = await importJson(P1, aliceJson);
    wantFiles(result, 0);
    result = await importJson(GUEST, aliceJson);
    wantFiles(result, 0);
    result = await importJson(ADMIN, aliceJson);
    wantFiles(result, 2); // admins see everything
    assert.equal((await api('PATCH', `/api/workflows/${alice.flow.id}/share`, ALICE, { shareMode: 'private' })).status, 200);
    result = await importJson(CAROL, aliceJson);
    wantFiles(result, 0); // the share was taken back
    result = await importJson(ADMIN, aliceJson);
    wantFiles(result, 2);

    // An edited file cannot reach what the person may not see: the check is made against the person for every
    // reference, whatever the file claims (a chat of Alice is named as the source).
    const chat = (await api('POST', '/api/sessions', ALICE, {})).json.session;
    const chatAsset = await sessionStore.saveAsset(chat.id, { kind: 'image', buffer: Buffer.concat([PNG, Buffer.from('chat')]), ext: '.png', prompt: 'chat image', cost: null });
    const tampered = JSON.parse(JSON.stringify(aliceJson));
    tampered.graph.nodes[0].params.asset = { type: 'image', sessionId: chat.id, assetId: chatAsset.id, file: chatAsset.file, url: chatAsset.url, missing: false };
    tampered.graph.nodes[1].params.asset = { ...tampered.graph.nodes[1].params.asset, sessionId: chat.id };
    result = await importJson(BOB, tampered);
    wantFiles(result, 0);
    result = await importJson(ALICE, tampered);
    assert.equal(result.files.imported, 1, 'Alice may see her own chat; the second reference names an asset that is not in it');
    // the same with a hand-made file that claims to be shared: nothing in the file counts
    tampered.shareMode = 'team';
    tampered.owner = BOB;
    tampered.sharedWith = [BOB];
    result = await importJson(CAROL, tampered);
    wantFiles(result, 0);

    /* ----- JSON import: participants and guests ----- */
    const p1 = await makeFlow(P1, 'P1 flow');
    const p1Json = await jsonOfFlow(P1, p1.flow);
    result = await importJson(P1, p1Json);
    wantFiles(result, 2); // their own
    assert.equal(result.workflow.owner, P1);
    assert.equal((await wfStore.readWorkflow(result.workflow.id)).teamId, team.id, 'the team of the importing person');
    result = await importJson(P2, p1Json);
    wantFiles(result, 0); // a teammate, nothing shared
    result = await importJson(P3, p1Json);
    wantFiles(result, 0);
    result = await importJson(ALICE, p1Json);
    wantFiles(result, 0); // internal people do not see a participant's private workflow either
    assert.equal((await api('PATCH', `/api/workflows/${p1.flow.id}/share`, P1, { shareMode: 'teams', sharedTeams: [team.id] })).status, 200);
    result = await importJson(P2, p1Json);
    wantFiles(result, 2); // shared with their course
    result = await importJson(P3, p1Json);
    wantFiles(result, 0); // another course
    result = await importJson(GUEST, p1Json);
    wantFiles(result, 0);
    result = await importJson(ALICE, p1Json);
    wantFiles(result, 0);
    assert.equal((await api('PATCH', `/api/workflows/${p1.flow.id}/share`, P1, { shareMode: 'specific', sharedWith: [P2] })).status, 200);
    result = await importJson(P2, p1Json);
    wantFiles(result, 2);
    result = await importJson(ADMIN, p1Json);
    wantFiles(result, 2);
    // a participant naming a workflow of existing data (no owner): it does not exist for them
    const legacy = (await wfStore.createWorkflow({ name: 'Old data' })).workflow;
    const legacyImage = assetsLib.valueFromLedgerEntry(legacy.sessionId, await sessionStore.saveAsset(legacy.sessionId, { kind: 'upload', buffer: PNG, ext: '.png', prompt: 'old.png', cost: null }));
    const legacyDoc = { ...aliceJson, graph: { nodes: [node('n1', 'input.image', { asset: legacyImage })], edges: [] } };
    wantFiles(await importJson(P1, legacyDoc), 0, 1);
    wantFiles(await importJson(GUEST, legacyDoc), 0, 1);
    wantFiles(await importJson(BOB, legacyDoc), 1, 1); // internal people see data without an owner

    const guest = await makeFlow(GUEST, 'Guest flow');
    const guestJson = await jsonOfFlow(GUEST, guest.flow);
    result = await importJson(GUEST, guestJson);
    wantFiles(result, 2);
    assert.equal(result.workflow.owner, GUEST);
    result = await importJson(P1, guestJson);
    wantFiles(result, 0);

    /* ----- export.zip and export-info: the access of the JSON export ----- */
    const zipOf = async (who, flow) => call('GET', `/api/workflows/${flow.id}/export.zip`, { as: who });
    assert.equal((await zipOf(ALICE, alice.flow)).status, 200);
    assert.equal((await zipOf(ADMIN, alice.flow)).status, 200);
    for (const [who, flow] of [[BOB, alice.flow], [P1, alice.flow], [GUEST, alice.flow], [P2, guest.flow], [CAROL, p1.flow], [P3, p1.flow], [GUEST, p1.flow]]) {
      const denied = await zipOf(who, flow);
      assert.equal(denied.status, 404, `${who} on ${flow.name}`);
      assert.equal(denied.json.code, 'WORKFLOW_NOT_FOUND');
      assert.equal((await api('GET', `/api/workflows/${flow.id}/export-info`, who)).status, 404);
      assert.equal((await api('GET', `/api/workflows/${flow.id}/export`, who)).status, 404, 'as the JSON export');
    }
    assert.equal((await zipOf(P2, p1.flow)).status, 200, 'shared with P2');
    assert.equal((await api('GET', `/api/workflows/${p1.flow.id}/export-info`, P2)).json.fileCount, 2);
    assert.equal((await zipOf(P1, p1.flow)).status, 200);
    assert.equal((await zipOf(GUEST, guest.flow)).status, 200);
    assert.equal((await zipOf(null, alice.flow)).status, 401, 'anonymous: the login is not confirmed');
    assert.equal((await call('POST', '/api/workflows/import-zip', { as: null, headers: { 'Content-Type': 'application/zip' }, body: Buffer.from('x') })).status, 401);

    /* ----- ZIP import: owner, team, folder, and the same rules for every role ----- */
    const projectFlow = await makeFlow(ALICE, 'In a project', 'Alpha');
    assert.equal(projectFlow.flow.folder, 'Alpha');
    const aliceZip = (await zipOf(ALICE, alice.flow)).buffer;
    const p1Zip = (await zipOf(P1, p1.flow)).buffer;
    const guestZip = (await zipOf(GUEST, guest.flow)).buffer;
    const importZip = (who, buffer, query = '') => call('POST', `/api/workflows/import-zip${query}`, { as: who, headers: { 'Content-Type': 'application/zip' }, body: buffer });

    let zipResult = await importZip(P2, p1Zip, `?name=${encodeURIComponent('P2 copy')}`);
    assert.equal(zipResult.status, 201, zipResult.text);
    assert.equal(zipResult.json.workflow.owner, P2, 'the owner is the importing person, not the exporting one');
    assert.equal(zipResult.json.workflow.shareMode, 'private');
    assert.equal(zipResult.json.workflow.name, 'P2 copy');
    wantFiles(zipResult.json, 2);
    const p2Copy = await wfStore.readWorkflow(zipResult.json.workflow.id);
    assert.equal(p2Copy.teamId, team.id, 'the team of the importing person');
    assert.equal((await sessionStore.readSession(p2Copy.sessionId)).owner, P2, 'the backing session belongs to them as well');
    assert.equal((await api('GET', `/api/workflows/${p2Copy.id}`, P1)).status, 404, 'private: not even the exporter sees it');
    const p2Asset = p2Copy.graph.nodes[0].params.asset;
    assert.equal((await call('GET', p2Asset.url, { as: P2 })).status, 200);
    assert.equal((await call('GET', p2Asset.url, { as: P1 })).status, 404);
    assert.equal(sha(await fsp.readFile(fileOf(p2Asset))), sha(Buffer.concat([PNG, Buffer.from('P1 flow')])));

    zipResult = await importZip(P3, p1Zip); // a participant of another course: imports into their own space
    assert.equal(zipResult.status, 201, zipResult.text);
    assert.equal((await wfStore.readWorkflow(zipResult.json.workflow.id)).teamId, otherTeam.id);
    zipResult = await importZip(GUEST, p1Zip); // a guest too
    assert.equal(zipResult.status, 201, zipResult.text);
    assert.equal(zipResult.json.workflow.owner, GUEST);
    assert.equal((await wfStore.readWorkflow(zipResult.json.workflow.id)).teamId ?? null, null, 'a guest has no team');
    zipResult = await importZip(BOB, aliceZip);
    assert.equal(zipResult.status, 201, zipResult.text);
    assert.equal(zipResult.json.workflow.owner, BOB);
    assert.equal((await wfStore.readWorkflow(zipResult.json.workflow.id)).teamId ?? null, null);
    zipResult = await importZip(ADMIN, guestZip);
    assert.equal(zipResult.status, 201, zipResult.text);
    assert.equal(zipResult.json.workflow.owner, ADMIN);

    // the folder: the project of somebody else does not exist for a participant (nothing is created), for the owner it does
    const countWorkflows = async () => (await wfStore.listWorkflows({})).length;
    const beforeFolder = await countWorkflows();
    const sessionsBefore = (await fsp.readdir(path.join(iso.root, 'projects'))).length;
    const foreign = await importZip(P1, p1Zip, '?folder=Alpha');
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(foreign.json.code, 'NOT_FOUND');
    assert.equal((await importZip(GUEST, guestZip, '?folder=Alpha')).status, 404);
    assert.equal(await countWorkflows(), beforeFolder, 'nothing was created');
    assert.equal((await fsp.readdir(path.join(iso.root, 'projects'))).length, sessionsBefore);
    assert.deepEqual((await fsp.readdir(assetsDir)).filter((name) => name.startsWith('.import-zip-')), []);
    const inFolder = await importZip(ALICE, aliceZip, '?folder=Alpha');
    assert.equal(inFolder.status, 201, inFolder.text);
    assert.equal(inFolder.json.workflow.folder, 'Alpha');
    assert.equal((await importZip(ADMIN, aliceZip, '?folder=Alpha')).status, 201);
    const ownFolder = await importZip(P1, p1Zip, '?folder=P1%20project');
    assert.equal(ownFolder.status, 201, 'a new project name is free to use');
    assert.equal(ownFolder.json.workflow.folder, 'P1 project');

    // a refused ZIP is refused the same way for every role (the checks do not depend on who sends it)
    for (const who of [ALICE, P1, GUEST, ADMIN]) {
      const bad = await importZip(who, Buffer.from('this is not a zip'));
      assert.equal(bad.status, 400, who);
      assert.equal(bad.json.code, 'INVALID_ARCHIVE');
      assert.equal(bad.json.reason, 'NOT_A_ZIP');
    }

    /* ----- an SVG opened directly cannot run scripts (the node upload keeps the source next to its PNG) ----- */
    const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script><rect width="8" height="8"/></svg>');
    const chatSvg = await sessionStore.saveAsset(chat.id, { kind: 'upload', buffer: evilSvg, ext: '.svg', prompt: 'logo.svg', cost: null });
    const svgResponse = await call('GET', chatSvg.url, { as: ALICE });
    assert.equal(svgResponse.status, 200);
    assert.match(svgResponse.headers['content-type'], /image\/svg\+xml/);
    assert.match(svgResponse.headers['content-security-policy'], /default-src 'none'/);
    assert.match(svgResponse.headers['content-security-policy'], /\bsandbox\b/);
    assert.equal(svgResponse.headers['x-content-type-options'], 'nosniff');
    const upperSvg = await sessionStore.saveAsset(chat.id, { kind: 'upload', buffer: evilSvg, ext: '.SVG', prompt: 'LOGO.SVG', cost: null }).catch(() => null);
    if (upperSvg) assert.match((await call('GET', upperSvg.url, { as: ALICE })).headers['content-security-policy'] || '', /sandbox/);
    const pngResponse = await call('GET', chatAsset.url, { as: ALICE });
    assert.equal(pngResponse.status, 200);
    assert.equal(pngResponse.headers['x-content-type-options'], 'nosniff');
    assert.equal(pngResponse.headers['content-security-policy'], undefined, 'other files are served as before');
    assert.equal((await call('GET', chatSvg.url, { as: BOB })).status, 404, 'access rules are unchanged');
  } finally {
    await iso.cleanup();
  }
}

async function main() {
  await part1();
  await part2();
  console.log('Workflow-ZIP: Export mit Dateien, Rundlauf mit Pruefsummen, alle Ablehnungen ohne Reste, Rueckgewinnung beim JSON-Import und Zugriff fuer Besitzer, Geteilte, Teilnehmende und Gaeste sind korrekt.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
