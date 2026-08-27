'use strict';

// Einmalige Migration: eingebettete base64-Bilder aus VERSTECKTEN
// Nachrichten in Dateien auslagern und in der Session nur noch einen image_ref
// hinterlassen. Versteckte Nachrichten sieht nur der Brain - das Frontend bekommt
// sie ohnehin nicht. Sichtbare Bilder (Uploads im Chatverlauf) bleiben unangetastet.
//
//   node scripts/migrate-inline-images.js            # Trockenlauf
//   node scripts/migrate-inline-images.js --apply    # anwenden (legt Backups an)

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const store = require('../lib/store');
const { PATHS } = require('../lib/config');

const APPLY = process.argv.includes('--apply');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  if (!match) return null;
  const mime = match[1].toLowerCase();
  return { mime, buffer: Buffer.from(match[2], 'base64'), ext: EXT_BY_MIME[mime] || '.png' };
}

async function migrateSession(id) {
  const session = await store.readSession(id);
  let ausgelagert = 0;
  let bytes = 0;

  for (const message of session.messages) {
    if (!message.hidden || !Array.isArray(message.content)) continue;
    for (let i = 0; i < message.content.length; i++) {
      const part = message.content[i];
      if (part?.type !== 'image_url') continue;
      const parsed = parseDataUrl(part.image_url?.url);
      if (!parsed) continue;
      bytes += String(part.image_url.url).length;
      ausgelagert += 1;
      if (!APPLY) continue;
      const { file } = await store.saveInlineImage(id, parsed.buffer, parsed.ext);
      message.content[i] = { type: 'image_ref', file, mime: parsed.mime };
    }
  }

  return { session, ausgelagert, bytes };
}

async function main() {
  const dateien = (await fsp.readdir(PATHS.projectsDir)).filter((f) => f.endsWith('.json'));
  const backupDir = path.join(path.dirname(PATHS.projectsDir), 'migration-backup-inline-images');
  if (APPLY) await fsp.mkdir(backupDir, { recursive: true });

  let gesamtBilder = 0;
  let gesamtBytes = 0;
  let geaenderteSessions = 0;

  for (const datei of dateien.sort()) {
    const id = path.basename(datei, '.json');
    let ergebnis;
    try {
      ergebnis = await migrateSession(id);
    } catch (err) {
      console.warn(`  ${id}: uebersprungen (${err.message})`);
      continue;
    }
    if (!ergebnis.ausgelagert) continue;

    geaenderteSessions += 1;
    gesamtBilder += ergebnis.ausgelagert;
    gesamtBytes += ergebnis.bytes;
    const vorher = fs.statSync(path.join(PATHS.projectsDir, datei)).size;

    if (APPLY) {
      await fsp.copyFile(path.join(PATHS.projectsDir, datei), path.join(backupDir, datei));
      // Ohne updatedAt-Update: die Migration ist keine inhaltliche Aenderung.
      await store.writeSession(ergebnis.session, { touchUpdatedAt: false });
      const nachher = fs.statSync(path.join(PATHS.projectsDir, datei)).size;
      console.log(`  ${id}: ${ergebnis.ausgelagert} Bilder, ${(vorher / 1e6).toFixed(1)} MB -> ${(nachher / 1e6).toFixed(1)} MB`);
    } else {
      console.log(`  ${id}: ${ergebnis.ausgelagert} Bilder (${(ergebnis.bytes / 1e6).toFixed(1)} MB) von ${(vorher / 1e6).toFixed(1)} MB`);
    }
  }

  console.log(
    `\n${geaenderteSessions} von ${dateien.length} Sessions betroffen, ${gesamtBilder} Bilder, ${(gesamtBytes / 1e6).toFixed(1)} MB`
  );
  if (APPLY) console.log(`Backups: ${backupDir}`);
  else console.log('TROCKENLAUF - nichts geschrieben. Mit --apply anwenden.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
