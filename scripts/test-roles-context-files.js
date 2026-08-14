'use strict';

const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');

const { app } = require('../server');
const { PATHS } = require('../lib/config');
const store = require('../lib/store');
const roles = require('../lib/roles');
const brain = require('../lib/brain');
const or = require('../lib/openrouter');

function routeHandler(path, method = 'get') {
  const layer = app._router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(path, { method = 'get', params = {}, body = {} } = {}) {
  const handler = routeHandler(path, method);
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) {
        result.status = code;
        return this;
      },
      json(value) {
        result.body = value;
        resolve(result);
      }
    };
    Promise.resolve(handler({ params, body, query: {}, kubleUser: 'test' }, res)).catch(reject);
  });
}

async function main() {
  const session = await store.createSession();
  const folder = `Kontext-Profil-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let roleId = null;
  let folderDeleted = false;
  try {
    await store.createFolder(folder);
    const listBefore = await invoke('/api/roles');
    assert.equal(listBefore.status, 200);
    assert.ok(Array.isArray(listBefore.body.roles));

    const defaultRole = await invoke('/api/roles/default');
    assert.equal(defaultRole.status, 200);
    assert.equal(defaultRole.body.name, 'Creative Director (Standard)');
    assert.equal(defaultRole.body.prompt, await brain.readBasePrompt());

    const longPromptPrefix = 'Du bist eine praezise Testrolle.\n\n';
    const longPrompt = `${longPromptPrefix}${'P'.repeat(12000 - [...longPromptPrefix].length)}`;
    assert.equal([...longPrompt].length, 12000);
    const created = await invoke('/api/roles', {
      method: 'post',
      body: {
        name: `Testrolle ${Date.now()}`,
        emoji: '🎬',
        description: 'Prueft den Rollenfluss.',
        prompt: longPrompt
      }
    });
    assert.equal(created.status, 201);
    assert.equal([...created.body.role.prompt].length, 12000);
    roleId = created.body.role.id;
    assert.ok(store.isValidId(roleId));

    const tooLong = await invoke('/api/roles', {
      method: 'post',
      body: {
        name: 'Zu lange Testrolle',
        prompt: 'P'.repeat(20001)
      }
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /maximal 20000 Zeichen/);

    const patched = await invoke('/api/sessions/:id', {
      method: 'patch',
      params: { id: session.id },
      body: { role: roleId }
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.session.role, roleId);

    const rolePrompt = await brain.roleSection(roleId);
    assert.match(rolePrompt, /# AKTIVE ROLLE:/);
    assert.match(rolePrompt, /praezise Testrolle/);

    const added = await invoke('/api/sessions/:id/context-files', {
      method: 'post',
      params: { id: session.id },
      body: { name: 'brief.md', text: '# Brief\n\nVerbindlicher Testkontext.' }
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.contextFiles.length, 1);
    assert.equal(added.body.contextFiles[0].name, 'brief.md');

    const filePrompt = await brain.contextFilesSection(session.id);
    assert.match(filePrompt, /# ATTACHED CONTEXT FILES/);
    assert.match(filePrompt, /Verbindlicher Testkontext/);

    const invalid = await invoke('/api/sessions/:id/context-files', {
      method: 'post',
      params: { id: session.id },
      body: { name: 'brief.pdf', text: 'Nicht erlaubt' }
    });
    assert.equal(invalid.status, 400);

    const longProjectText = `${'P'.repeat(60020)} ENDE`;
    const projectAdded = await invoke('/api/folders/:name/profile/context-files', {
      method: 'post',
      params: { name: folder },
      body: { name: 'projekt-brief.markdown', text: longProjectText }
    });
    assert.equal(projectAdded.status, 201);
    assert.equal(projectAdded.body.contextFiles.length, 1);
    assert.equal(projectAdded.body.file.chars, 60000);

    const projectFiles = await store.readFolderContextFiles(folder);
    assert.equal(projectFiles.length, 1);
    assert.equal([...projectFiles[0].text].length, 60000);
    assert.match(projectFiles[0].text, /\[gekuerzt\]$/);

    const profileResponse = await invoke('/api/folders/:name/profile', { params: { name: folder } });
    assert.equal(profileResponse.status, 200);
    assert.equal(profileResponse.body.profile.contextFiles[0].name, 'projekt-brief.markdown');

    const savedProfile = await invoke('/api/folders/:name/profile', {
      method: 'put',
      params: { name: folder },
      body: { guidelines: 'Dateien beim Speichern bewahren.', contextBrains: [], brandings: [] }
    });
    assert.equal(savedProfile.status, 200);
    assert.equal(savedProfile.body.profile.contextFiles.length, 1);

    const combinedPrompt = await brain.contextFilesSection(session.id, folder, profileResponse.body.profile);
    assert.match(combinedPrompt, /## projekt-brief\.markdown \(Projekt-Profil\)/);
    assert.match(combinedPrompt, /## brief\.md/);
    assert.ok(
      combinedPrompt.indexOf('projekt-brief.markdown (Projekt-Profil)') < combinedPrompt.indexOf('## brief.md'),
      'Projektdateien muessen vor Session-Dateien stehen'
    );

    const invalidProjectFile = await invoke('/api/folders/:name/profile/context-files', {
      method: 'post',
      params: { name: folder },
      body: { name: 'projekt.pdf', text: 'Nicht erlaubt' }
    });
    assert.equal(invalidProjectFile.status, 400);

    for (let index = 2; index <= 5; index += 1) {
      await store.addFolderContextFile(folder, `projekt-${index}.txt`, `Projektdatei ${index}`);
    }
    await assert.rejects(
      store.addFolderContextFile(folder, 'projekt-6.md', 'Zu viel'),
      /maximal 5/
    );

    const projectRemoved = await invoke('/api/folders/:name/profile/context-files/:fileId', {
      method: 'delete',
      params: { name: folder, fileId: projectAdded.body.file.id }
    });
    assert.equal(projectRemoved.status, 200);
    assert.equal(projectRemoved.body.contextFiles.length, 4);
    assert.equal((await store.readFolderContextFiles(folder)).length, 4);

    const profileWithFourFiles = await store.readFolderProfile(folder);
    const missingFile = path.join(
      PATHS.root,
      'data',
      'folder-context-files',
      `${profileWithFourFiles.contextFiles.at(-1).id}.md`
    );
    await fsp.rm(missingFile);
    assert.equal((await store.readFolderContextFiles(folder)).length, 3, 'Fehlende Dateien auf Platte muessen uebersprungen werden');

    const missingFolder = await invoke('/api/folders/:name/profile/context-files', {
      method: 'post',
      params: { name: `Fehlt-${Date.now()}` },
      body: { name: 'brief.md', text: 'Nicht speichern' }
    });
    assert.equal(missingFolder.status, 404);

    const removed = await invoke('/api/sessions/:id/context-files/:fileId', {
      method: 'delete',
      params: { id: session.id, fileId: added.body.file.id }
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.contextFiles, []);

    const remainingProfile = await store.readFolderProfile(folder);
    const cleanupFileId = remainingProfile.contextFiles[0].id;
    const cleanupFile = path.join(PATHS.root, 'data', 'folder-context-files', `${cleanupFileId}.md`);
    await fsp.access(cleanupFile);
    await store.deleteFolder(folder);
    folderDeleted = true;
    await assert.rejects(fsp.access(cleanupFile), (err) => err.code === 'ENOENT');
    assert.equal(await store.readFolderProfile(folder), null);

    if (!or.hasKey()) {
      const generatorWithoutKey = await invoke('/api/roles/generate', {
        method: 'post',
        body: { name: 'Test', brief: 'Erstelle einen Test.' }
      });
      assert.equal(generatorWithoutKey.status, 503);
    }

    console.log('Rollen und Kontextdateien: Chat- und Projekt-CRUD, Limits, Kappung, Aufraeumen und Prompt-Injektion sind korrekt.');
  } finally {
    await store.deleteSession(session.id);
    if (!folderDeleted) await store.deleteFolder(folder).catch(() => {});
    if (roleId) await roles.deleteRole(roleId).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
