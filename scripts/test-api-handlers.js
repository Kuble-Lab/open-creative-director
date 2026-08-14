'use strict';

const assert = require('assert/strict');

const { app } = require('../server');
const store = require('../lib/store');

function routeHandler(path, method = 'get') {
  const layer = app._router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(path, { method = 'get', params = {}, body = {}, query = {} } = {}) {
  const handler = routeHandler(path, method);
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) {
        result.status = code;
        return this;
      },
      json(body) {
        result.body = body;
        resolve(result);
      }
    };
    Promise.resolve(handler({ params, body, query }, res)).catch(reject);
  });
}

function invokeGet(path) {
  return invoke(path);
}

async function main() {
  const promptPresetsResponse = await invokeGet('/api/prompt-presets');
  assert.equal(promptPresetsResponse.status, 200);
  assert.ok(Array.isArray(promptPresetsResponse.body));
  assert.equal(promptPresetsResponse.body.length, 19);
  assert.deepEqual(Object.keys(promptPresetsResponse.body[0]), ['id', 'title', 'description', 'prompt', 'group']);

  const costResponse = await invokeGet('/api/costs/summary');
  assert.equal(costResponse.status, 200);
  assert.equal(typeof costResponse.body.total, 'number');
  assert.ok(Array.isArray(costResponse.body.bySession));

  const renderResponse = await invokeGet('/api/rendernode/status');
  assert.equal(renderResponse.status, 200);
  assert.equal(typeof renderResponse.body.enabled, 'boolean');
  if (renderResponse.body.enabled) {
    assert.equal(typeof renderResponse.body.online, 'boolean');
    assert.equal(typeof renderResponse.body.running, 'boolean');
    assert.equal(typeof renderResponse.body.queue, 'number');
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const folder = `API-Profil-${suffix}`;
  const registryFolder = `API-Projekt-${suffix}`;
  const directFolder = `API-Direkt-${suffix}`;
  const patchedFolder = `API-Patch-${suffix}`;
  const renameSource = `API-Rename-Quelle-${suffix}`;
  const renameTarget = `API-Rename-Ziel-${suffix}`;
  const cleanup = new Set([folder, registryFolder, directFolder, patchedFolder, renameSource, renameTarget]);
  const session = await store.createSession();
  try {
    await store.mutateSession(session.id, (saved) => {
      saved.messages.push(
        { role: 'user', content: 'Sichtbare Testnachricht' },
        { role: 'user', content: 'Verdeckte Testnachricht', hidden: true }
      );
    });
    const detailResponse = await invoke('/api/sessions/:id', { params: { id: session.id } });
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(detailResponse.body.session.messages, [{ role: 'user', content: 'Sichtbare Testnachricht' }]);
    const storedWithHiddenMessage = await store.readSession(session.id);
    assert.equal(storedWithHiddenMessage.messages.some((message) => message.hidden === true), true);

    const createFolderResponse = await invoke('/api/folders', {
      method: 'post',
      body: { name: `  ${registryFolder}  ` }
    });
    assert.equal(createFolderResponse.status, 201);
    assert.deepEqual(createFolderResponse.body, {
      folder: { name: registryFolder, hasProfile: false, sessionCount: 0 }
    });

    const duplicateFolderResponse = await invoke('/api/folders', {
      method: 'post',
      body: { name: registryFolder }
    });
    assert.equal(duplicateFolderResponse.status, 409);

    await store.createFolder(renameSource);
    const renameFolderResponse = await invoke('/api/folders/:name', {
      method: 'patch',
      params: { name: renameSource },
      body: { name: `  ${renameTarget}  ` }
    });
    assert.equal(renameFolderResponse.status, 200);
    assert.deepEqual(renameFolderResponse.body, { ok: true, oldName: renameSource, name: renameTarget });
    const renameConflictResponse = await invoke('/api/folders/:name', {
      method: 'patch',
      params: { name: renameTarget },
      body: { name: registryFolder.toLowerCase() }
    });
    assert.equal(renameConflictResponse.status, 409);
    await store.deleteFolder(renameTarget);

    const listedFoldersResponse = await invoke('/api/folders');
    assert.equal(listedFoldersResponse.status, 200);
    assert.ok(
      listedFoldersResponse.body.folders.some(
        (entry) => entry.name === registryFolder && entry.hasProfile === false && entry.sessionCount === 0
      )
    );

    await store.updateSessionMeta(session.id, { folder: registryFolder });
    const occupiedListResponse = await invoke('/api/folders');
    assert.ok(
      occupiedListResponse.body.folders.some(
        (entry) => entry.name === registryFolder && entry.hasProfile === false && entry.sessionCount === 1
      )
    );
    const occupiedDeleteResponse = await invoke('/api/folders/:name', {
      method: 'delete',
      params: { name: registryFolder }
    });
    assert.equal(occupiedDeleteResponse.status, 409);
    assert.equal(occupiedDeleteResponse.body.error, 'Zuerst Chats verschieben oder loeschen');

    await store.updateSessionMeta(session.id, { folder: null });
    const deleteFolderResponse = await invoke('/api/folders/:name', {
      method: 'delete',
      params: { name: registryFolder }
    });
    assert.equal(deleteFolderResponse.status, 200);
    assert.deepEqual(deleteFolderResponse.body, { ok: true, name: registryFolder });

    const emptyProfileResponse = await invoke('/api/folders/:name/profile', {
      params: { name: folder }
    });
    assert.equal(emptyProfileResponse.status, 200);
    assert.deepEqual(emptyProfileResponse.body, { profile: null });

    const putProfileResponse = await invoke('/api/folders/:name/profile', {
      method: 'put',
      params: { name: folder },
      body: { guidelines: '  Warm und praezise  ', contextBrains: ['  brain-a  ', 'brain-b'] }
    });
    assert.equal(putProfileResponse.status, 200);
    assert.equal(putProfileResponse.body.profile.guidelines, 'Warm und praezise');
    assert.deepEqual(putProfileResponse.body.profile.contextBrains, ['brain-a', 'brain-b']);
    const profiledListResponse = await invoke('/api/folders');
    assert.ok(
      profiledListResponse.body.folders.some(
        (entry) => entry.name === folder && entry.hasProfile === true && entry.sessionCount === 0
      )
    );

    const savedProfileResponse = await invoke('/api/folders/:name/profile', {
      params: { name: folder }
    });
    assert.equal(savedProfileResponse.body.profile.guidelines, 'Warm und praezise');

    const invalidProfileResponse = await invoke('/api/folders/:name/profile', {
      method: 'put',
      params: { name: folder },
      body: { contextBrains: ['1', '2', '3', '4', '5', '6'] }
    });
    assert.equal(invalidProfileResponse.status, 400);

    const createdInFolder = await invoke('/api/sessions', {
      method: 'post',
      body: { folder: `  ${directFolder}  ` }
    });
    assert.equal(createdInFolder.status, 201);
    assert.equal(createdInFolder.body.session.folder, directFolder);
    assert.equal(createdInFolder.body.session.title, 'Neuer Chat');
    await store.deleteSession(createdInFolder.body.session.id);
    await store.deleteFolder(directFolder);

    const patchResponse = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { title: '  API-Test  ', folder: `  ${patchedFolder}  ` }
    });
    assert.equal(patchResponse.status, 200);
    assert.deepEqual(patchResponse.body, {
      ok: true,
      session: { id: session.id, title: 'API-Test', folder: patchedFolder, brandings: [] }
    });

    const emptyTitleResponse = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { title: '   ' }
    });
    assert.equal(emptyTitleResponse.status, 400);

    const invalidFolderResponse = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { folder: 42 }
    });
    assert.equal(invalidFolderResponse.status, 400);

    const invalidIdResponse = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: '../ungueltig' },
      body: { folder: null }
    });
    assert.equal(invalidIdResponse.status, 400);

    const missingResponse = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: `missing-${Date.now()}` },
      body: { folder: null }
    });
    assert.equal(missingResponse.status, 404);
  } finally {
    await store.deleteSession(session.id);
    for (const name of cleanup) {
      try {
        await store.deleteFolder(name);
      } catch (_) {
        /* Bestmoegliches Aufraeumen der eindeutigen Testprojekte. */
      }
    }
  }
  console.log(JSON.stringify({ costs: costResponse.body, rendernode: renderResponse.body }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
