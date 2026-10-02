'use strict';

// Auto-Vorschauen und Konsistenz-Frames lagen frueher als base64 direkt in der
// Session-Datei. In gewachsenen Sessions summiert sich das auf hunderte Megabyte, die
// bei jedem Chat-Zug gelesen UND geschrieben werden. Sie liegen jetzt als Datei im
// Asset-Ordner, in der Session steht nur noch ein image_ref-Verweis. Erst kurz vor
// dem API-Call werden die juengsten Bilder daraus geladen.

const assert = require('node:assert/strict');

const store = require('../lib/store');
const { resolveImageRefs, toApiMessages } = require('../lib/brain');

const MAX_API_IMAGES = 6;

function bildNachricht(file) {
  return {
    role: 'user',
    hidden: true,
    content: [
      { type: 'text', text: '[System] Automatische Vorschau zur Pruefung:' },
      { type: 'image_ref', file, mime: 'image/jpeg' }
    ]
  };
}

async function main() {
  const session = await store.createSession();
  try {
    // Ein Bild mehr, als das Budget zulaesst.
    const anzahl = MAX_API_IMAGES + 2;
    const nachrichten = [];
    for (let i = 0; i < anzahl; i++) {
      const { file } = await store.saveInlineImage(session.id, Buffer.from(`bild-${i}`), '.jpg');
      nachrichten.push(bildNachricht(file));
    }

    // Gleicher Inhalt zweimal gespeichert: nur eine Datei (Dedupe ueber den Hash).
    const a = await store.saveInlineImage(session.id, Buffer.from('doppelt'), '.jpg');
    const b = await store.saveInlineImage(session.id, Buffer.from('doppelt'), '.jpg');
    assert.equal(a.file, b.file, 'gleicher Bildinhalt muss dieselbe Datei ergeben');

    const aufgeloest = await resolveImageRefs(session.id, nachrichten);
    const bilder = aufgeloest.flatMap((m) => m.content).filter((p) => p.type === 'image_url');
    const platzhalter = aufgeloest
      .flatMap((m) => m.content)
      .filter((p) => p.type === 'text' && p.text.startsWith('[Aeltere Bild-Vorschau'));

    assert.equal(bilder.length, MAX_API_IMAGES, `nur ${MAX_API_IMAGES} Bilder duerfen an die API gehen`);
    assert.equal(platzhalter.length, anzahl - MAX_API_IMAGES, 'aeltere Bilder werden zu Hinweistext');
    assert.ok(bilder.every((p) => p.image_url.url.startsWith('data:image/jpeg;base64,')), 'Bilder als data-URL');

    // Die juengsten Nachrichten behalten ihre Bilder, die aeltesten nicht.
    const letzte = aufgeloest[aufgeloest.length - 1].content;
    const erste = aufgeloest[0].content;
    assert.ok(letzte.some((p) => p.type === 'image_url'), 'die juengste Vorschau muss erhalten bleiben');
    assert.ok(!erste.some((p) => p.type === 'image_url'), 'die aelteste Vorschau faellt aus dem Budget');

    // Fehlende Datei darf den Turn nicht sprengen.
    const kaputt = await resolveImageRefs(session.id, [bildNachricht('inline/gibtesnicht.jpg')]);
    assert.ok(
      kaputt[0].content.some((p) => p.type === 'text' && p.text.includes('nicht mehr lesbar')),
      'fehlende Datei wird zu einem lesbaren Hinweis'
    );

    // Text-only-Brain: keine Bildteile im Payload, aber ein Hinweis auf die Bilder.
    const textOnly = toApiMessages(nachrichten, false);
    assert.ok(
      textOnly.every((m) => typeof m.content === 'string'),
      'ohne Bildmodell darf kein Bildteil im Payload landen'
    );
    assert.ok(textOnly.some((m) => m.content.includes('Bild(er) liegen lokal vor')), 'Hinweis auf die Bilder fehlt');

    console.log('OK: Bilder liegen als Datei, nur die juengsten gehen an die API');
  } finally {
    await store.deleteSession(session.id);
  }
  console.log('test-inline-images.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
