'use strict';

const assert = require('assert/strict');

const store = require('../lib/store');

async function main() {
  store.ensureDirs();
  const session = await store.createSession();
  const folder = `Session-Meta-${Date.now()}`;

  try {
    const originalUpdatedAt = session.updatedAt;
    const updated = await store.updateSessionMeta(session.id, {
      title: '  Kampagnenfilm Sommer  ',
      folder: `  ${folder}  `
    });
    assert.deepEqual(updated, {
      id: session.id,
      title: 'Kampagnenfilm Sommer',
      folder,
      brandings: []
    });

    const saved = await store.readSession(session.id);
    assert.equal(saved.title, 'Kampagnenfilm Sommer');
    assert.equal(saved.folder, folder);
    assert.equal(saved.updatedAt, originalUpdatedAt);

    const listed = await store.listSessions({ q: 'Kampagnenfilm Sommer', limit: 100 });
    assert.equal(listed.sessions.find((entry) => entry.id === session.id)?.folder, folder);

    // An open project asks for its own chats: only that project comes back,
    // however many newer chats sit in front of it in the paged list.
    const ofProject = await store.listSessions({ folder: ` ${folder} `, limit: 100 });
    assert.deepEqual(ofProject.sessions.map((entry) => entry.id), [session.id]);
    assert.equal(ofProject.total, 1);
    const ofOtherProject = await store.listSessions({ folder: `${folder}-gibt-es-nicht`, limit: 100 });
    assert.equal(ofOtherProject.total, 0);

    // Renaming is not work on the chat: updatedAt stays, so the side menu does
    // not reshuffle its projects because somebody fixed a typo in a title.
    const beforeRename = (await store.readSession(session.id)).updatedAt;
    await store.updateSessionMeta(session.id, { title: 'Anderer Titel' });
    assert.equal((await store.readSession(session.id)).updatedAt, beforeRename);

    await store.mutateSession(
      session.id,
      (savedSession) => {
        savedSession.messages.push(
          { role: 'assistant', content: 'Sichtbarer Suchtreffer Alpha' },
          { role: 'assistant', content: 'Verdeckter Suchtreffer Beta', hidden: true },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,SuchtrefferGamma' } },
              { type: 'text', text: 'Textteil Suchtreffer Delta' }
            ]
          }
        );
      },
      { touchUpdatedAt: false }
    );
    const cachedSearch = await store.listSessions({ q: 'Suchtreffer Alpha', limit: 100 });
    assert.match(cachedSearch.sessions.find((entry) => entry.id === session.id)?.snippet || '', /Suchtreffer Alpha/);
    const hiddenSearch = await store.listSessions({ q: 'Suchtreffer Beta', limit: 100 });
    assert.equal(hiddenSearch.sessions.some((entry) => entry.id === session.id), false);
    const imageSearch = await store.listSessions({ q: 'SuchtrefferGamma', limit: 100 });
    assert.equal(imageSearch.sessions.some((entry) => entry.id === session.id), false);
    const textPartSearch = await store.listSessions({ q: 'Suchtreffer Delta', limit: 100 });
    assert.match(textPartSearch.sessions.find((entry) => entry.id === session.id)?.snippet || '', /Suchtreffer Delta/);

    await assert.rejects(store.updateSessionMeta(session.id, { folder: 'O'.repeat(61) }), /maximal 60/);
    await store.updateSessionMeta(session.id, { title: 'T'.repeat(121) });
    const truncated = await store.readSession(session.id);
    assert.equal([...truncated.title].length, 120);
    assert.equal(truncated.folder, folder);

    await store.updateSessionMeta(session.id, { folder: null });
    const withoutFolder = await store.readSession(session.id);
    assert.equal(withoutFolder.folder, null);
    assert.equal(withoutFolder.updatedAt, originalUpdatedAt);

    console.log('Session-Metadaten: OK');
  } finally {
    await store.deleteSession(session.id);
    await store.deleteFolder(folder);
  }
  console.log('test-session-meta.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
