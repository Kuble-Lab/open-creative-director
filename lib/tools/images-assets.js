'use strict';

// Image generation, branding and cast asset tools, moved from lib/tools.js.

const gemini = require('../gemini-images');
const or = require('../openrouter');
const store = require('../store');
const resultMeta = require('../result-meta');
const gts = require('../gts');
const brandings = require('../brandings');
const path = require('path');
const fsp = require('fs/promises');
const access = require('../access');
const cast = require('../cast');
const {
  recordToolCost,
  shorten,
  referencesFromAssetIds,
  extFromMediaType,
  storeImportedSessionAsset,
  viewerOfCtx,
  requiredString
} = require('./shared');

// Where an image call goes, for generate_image and edit_image (the payload is always the one of OpenRouter). With GEMINI_API_KEY,
// the Google models of lib/gemini-images.js go straight to Google; every other call goes to OpenRouter exactly as before. When Google
// fails for a reason of the key, the account or the service (err.fallback, the list is in lib/gemini-images.js) and OpenRouter has a
// key, the same payload is tried ONCE through OpenRouter, with a warning in the log. A block of the safety filter and any other 400
// stay here: image nodes handle safety retries separately (WP52b). When the repeat fails too, its error says what
// Google did before.
async function createImage(payload) {
  if (!gemini.accepts(payload)) return or.createImage(payload);
  let failure;
  try {
    return await gemini.createImage(payload);
  } catch (err) {
    if (!(err instanceof gemini.GeminiImageError) || !err.fallback || !or.hasKey()) throw err;
    failure = err;
  }
  console.warn(`[gemini] ${payload.model}: kein Bild von Google (${failure.summary}), ein Versuch ueber OpenRouter.`);
  try {
    return await or.createImage(payload);
  } catch (err) {
    if (err instanceof Error) err.message = `${err.message} (Google zuvor: ${failure.summary})`;
    throw err;
  }
}

// Refused images can report usage too. Book only reported costs, with the model of this attempt.
async function billedImageCall(ctx, payload) {
  try {
    return await createImage(payload);
  } catch (err) {
    // OpenRouter can include usage in a refused response body.
    if (!err?.usage && gemini.isSafetyBlock(err)) {
      try {
        const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
        if (Number.isFinite(body?.usage?.cost)) err.usage = { cost: body.usage.cost };
      } catch (_) {
        /* no reported usage */
      }
    }
    if (Number.isFinite(err?.usage?.cost) && err.usage.cost >= 0) {
      await recordToolCost({
        ts: new Date().toISOString(), sessionId: ctx.sessionId, type: 'image',
        model: payload.model, cost: err.usage.cost, user: ctx.user || 'lokal'
      }, ctx);
    }
    throw err;
  }
}

async function runGenerateImage(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  ctx.emit({ type: 'tool_start', tool: 'generate_image', label: `Erzeuge Bild: ${shorten(prompt, 90)}` });

  const payload = { model: ctx.config.imageModel, prompt, n: 1 };
  if (args.aspect_ratio) payload.aspect_ratio = args.aspect_ratio;

  const result = await billedImageCall(ctx, payload);
  return storeImageResult(ctx, result, prompt, payload.model);
}

async function runEditImage(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  const refIds = Array.isArray(args.reference_asset_ids) ? args.reference_asset_ids : [];
  if (!prompt) throw new Error('prompt fehlt');
  if (refIds.length === 0) throw new Error('reference_asset_ids muss mindestens ein Asset enthalten');
  ctx.emit({
    type: 'tool_start',
    tool: 'edit_image',
    label: `Bearbeite Bild (${refIds.join(', ')}): ${shorten(prompt, 70)}`
  });

  const payload = {
    model: ctx.config.imageModel,
    prompt,
    n: 1,
    input_references: await referencesFromAssetIds(ctx.sessionId, refIds)
  };
  if (args.aspect_ratio) payload.aspect_ratio = args.aspect_ratio;

  const result = await billedImageCall(ctx, payload);
  return storeImageResult(ctx, result, prompt, payload.model);
}

// Shared image post-processing: save file, emit asset, inject preview for the brain.
async function storeImageResult(ctx, result, prompt, model) {
  const item = result?.data?.[0];
  if (!item?.b64_json) throw new Error('Antwort der Bild-API enthielt keine Bilddaten.');
  const cost = typeof result?.usage?.cost === 'number' ? result.usage.cost : null;
  const buffer = Buffer.from(item.b64_json, 'base64');
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'image',
    buffer,
    ext: extFromMediaType(item.media_type),
    prompt,
    cost,
    model
  });
  if (cost !== null) {
    await recordToolCost({
      ts: asset.createdAt,
      sessionId: ctx.sessionId,
      assetId: asset.id,
      type: 'image',
      model,
      cost,
      user: ctx.user || 'lokal'
    }, ctx);
  }

  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'image', prompt, cost: asset.cost, ...resultMeta.describe(asset) }
  });

  return {
    toolResult: `Bild erzeugt: ${asset.id} (Datei ${asset.file}). Das Bild wird dir direkt im Anschluss zur Pruefung gezeigt.`,
    inject: [
      {
        role: 'user',
        hidden: true,
        content: [
          { type: 'text', text: `[System] Automatische Vorschau von ${asset.id} zur Pruefung:` },
          // Verweis statt base64: die Datei liegt bereits im Session-Asset-Ordner.
          { type: 'image_ref', file: asset.file, mime: item.media_type || 'image/png' }
        ]
      }
    ],
    asset
  };
}

async function runImportGtsAsset(ctx, args) {
  const brainId = String(args.brain_id || '').trim();
  const requestedFilename = String(args.filename || '').trim();
  if (!brainId) throw new Error('brain_id fehlt');
  if (!requestedFilename) throw new Error('filename fehlt');

  ctx.emit({
    type: 'tool_start',
    tool: 'import_gts_asset',
    label: `Importiere GTS-Datei: ${shorten(requestedFilename, 90)}`
  });

  const assets = await gts.listAssets(brainId);
  const filenameLower = requestedFilename.toLowerCase();
  const source = assets.find((asset) => asset.filename.toLowerCase() === filenameLower);
  if (!source) throw new Error(`Datei ${requestedFilename} ist nicht an Brain ${brainId} angehaengt.`);

  return storeImportedSessionAsset(ctx, {
    buffer: await gts.downloadAsset(source.url),
    filename: source.filename,
    prompt: `GTS-Import: ${source.filename} aus ${brainId}`,
    sourceLabel: 'GTS-Datei',
    mimeType: source.mimeType
  });
}

// Brandings are global and attached to every project; importing and deleting them is admin-only, so changing them
// through the Director is as well (as soon as the user management is active).
function requireBrandingAdmin(ctx, tool) {
  if (viewerOfCtx(ctx).admin) return;
  throw new Error(`${tool} ist nur fuer Admins verfuegbar: Brandings gelten fuer alle Projekte. Bitte einen Admin bitten, das Branding anzulegen oder zu aendern.`);
}

async function runCreateBranding(ctx, args) {
  requireBrandingAdmin(ctx, 'create_branding');
  const name = requiredString(args.name, 'name');
  const description = args.description === undefined ? '' : String(args.description);
  ctx.emit({ type: 'tool_start', tool: 'create_branding', label: `Erstelle Branding: ${shorten(name, 90)}` });
  const branding = await brandings.createBranding({ name, description });
  return {
    toolResult: `Branding erstellt: ${branding.name} (ID ${branding.id}). Nutze jetzt update_branding fuer die Inhalte und add_branding_asset fuer bestaetigte Assets.`,
    inject: []
  };
}

async function runUpdateBranding(ctx, args) {
  requireBrandingAdmin(ctx, 'update_branding');
  const brandingId = await brandings.resolveBrandingId(requiredString(args.branding_id, 'branding_id'));
  if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
    throw new Error('patch muss ein Objekt sein');
  }
  ctx.emit({ type: 'tool_start', tool: 'update_branding', label: `Aktualisiere Branding ${brandingId}` });
  const updated = await brandings.updateBranding(brandingId, args.patch);
  const fields = Object.keys(args.patch);
  return {
    toolResult: `Branding ${updated.name} (${updated.id}) aktualisiert. Gesetzt: ${fields.length ? fields.join(', ') : 'keine Felder'}.`,
    inject: []
  };
}

async function sessionAssetBuffer(sessionId, assetId) {
  if (!store.isValidId(assetId)) throw new Error(`Ungueltige Session-Asset-ID: ${assetId}`);
  const ledger = await store.readLedger(sessionId);
  const entry = ledger.find((item) => item.id === assetId);
  if (!entry) throw new Error(`Session-Asset nicht gefunden: ${assetId}`);
  if (entry.pending) throw new Error(`Session-Asset ${assetId} ist noch nicht fertig`);
  const storedFile = String(entry.file || '');
  if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
    throw new Error(`Session-Asset ${assetId} hat einen ungueltigen Dateinamen`);
  }
  try {
    return {
      entry,
      buffer: await fsp.readFile(path.join(store.sessionAssetDir(sessionId), storedFile))
    };
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Session-Asset ${assetId} konnte nicht gelesen werden: Datei fehlt`);
    throw err;
  }
}

function cleanMeta(meta) {
  const input = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  return {
    variant: typeof input.variant === 'string' ? input.variant.trim() : '',
    usage: typeof input.usage === 'string' ? input.usage.trim() : '',
    title: typeof input.title === 'string' ? input.title.trim() : ''
  };
}

async function runAddBrandingAsset(ctx, args) {
  requireBrandingAdmin(ctx, 'add_branding_asset');
  const brandingId = await brandings.resolveBrandingId(requiredString(args.branding_id, 'branding_id'));
  const assetId = requiredString(args.session_asset_id, 'session_asset_id');
  const target = requiredString(args.target, 'target');
  if (!['logo', 'imagery', 'outro', 'sound', 'font'].includes(target)) {
    throw new Error('target muss logo, imagery, outro, sound oder font sein');
  }
  await brandings.readBranding(brandingId);
  const { entry, buffer } = await sessionAssetBuffer(ctx.sessionId, assetId);
  const meta = cleanMeta(args.meta);
  ctx.emit({
    type: 'tool_start',
    tool: 'add_branding_asset',
    label: `Sichere ${assetId} im Branding ${brandingId}`
  });
  const saved = await brandings.saveBrandingAsset(brandingId, { buffer, filename: entry.file });

  try {
    const branding = await brandings.readBranding(brandingId);
    let patch;
    if (target === 'logo') {
      patch = {
        logos: [...branding.logos, { variant: meta.variant || 'primary', file: saved.file, usage: meta.usage }]
      };
    } else if (target === 'imagery') {
      patch = {
        imagery: {
          ...branding.imagery,
          references: [...branding.imagery.references, saved.file]
        }
      };
    } else if (target === 'outro') {
      patch = { motion: { ...branding.motion, outro: saved.file } };
    } else if (target === 'sound') {
      patch = {
        sound: [...branding.sound, {
          title: meta.title || path.basename(saved.filename, path.extname(saved.filename)),
          file: saved.file,
          usage: meta.usage || 'background'
        }]
      };
    } else {
      patch = {
        typography: [...branding.typography, {
          role: meta.variant || 'brand',
          family: meta.title || path.basename(saved.filename, path.extname(saved.filename)),
          weights: '',
          source: 'upload',
          file: saved.file,
          usage: meta.usage
        }]
      };
    }
    await brandings.updateBranding(brandingId, patch);
  } catch (err) {
    await brandings.removeBrandingAsset(brandingId, saved.filename).catch(() => {});
    throw err;
  }

  return {
    toolResult: `Session-Asset ${assetId} als ${target} im Branding ${brandingId} gesichert: ${saved.filename}.`,
    inject: []
  };
}

const BRANDING_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

async function runImportBrandingAsset(ctx, args) {
  const brandingId = await brandings.resolveBrandingId(requiredString(args.branding_id, 'branding_id'));
  const filename = requiredString(args.filename, 'filename');
  ctx.emit({
    type: 'tool_start',
    tool: 'import_branding_asset',
    label: `Importiere Branding-Datei: ${shorten(filename, 90)}`
  });
  const buffer = await brandings.readBrandingAsset(brandingId, filename);
  return storeImportedSessionAsset(ctx, {
    buffer,
    filename,
    prompt: `Branding-Import: ${filename} aus ${brandingId}`,
    sourceLabel: 'Branding-Datei',
    mimeType: BRANDING_MIME_TYPES[path.extname(filename).toLowerCase()] || ''
  });
}

async function requireProjectFolder(ctx) {
  const session = await store.readSession(ctx.sessionId);
  const folder = typeof session.folder === 'string' ? session.folder.trim() : '';
  if (!folder) {
    throw new Error('Casting ist nur in einem Projekt verfuegbar. Verschiebe diesen Chat zuerst in ein Projekt.');
  }
  // Participants and guests may change the cast only in a project of their own (in a shared chat of somebody else
  // the project, and its cast, belongs to the owner and stays invisible to them).
  const viewer = viewerOfCtx(ctx);
  if (access.isRestricted(viewer) && (!viewer.email || (await store.folderOwner(folder)) !== viewer.email)) {
    throw new access.RoleRestrictedError(
      'cast',
      'The cast of this project is not available for your account',
      'Der Cast dieses Projekts ist für dein Konto nicht verfügbar.'
    );
  }
  return folder;
}

async function castSourceAssets(sessionId, rawIds, field, allowedExtensions, maxItems) {
  if (rawIds === undefined || rawIds === null) return [];
  if (!Array.isArray(rawIds)) throw new Error(`${field} muss ein Array sein`);
  if (rawIds.length > maxItems) throw new Error(`${field} darf maximal ${maxItems} Assets enthalten`);
  const ledger = await store.readLedger(sessionId);
  return rawIds.map((rawId) => {
    const id = requiredString(rawId, field);
    const asset = ledger.find((entry) => entry.id === id);
    if (!asset) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (asset.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    const ext = path.extname(asset.file).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) hat fuer ${field} den falschen Dateityp.`);
    }
    return asset;
  });
}

async function castSourceAsset(sessionId, rawId, field, allowedExtensions) {
  if (rawId === undefined || rawId === null || rawId === '') return null;
  return (await castSourceAssets(sessionId, [rawId], field, allowedExtensions, 1))[0];
}

async function runCreateCastMember(ctx, args) {
  const folder = await requireProjectFolder(ctx);
  const name = requiredString(args.name, 'name');
  const soul = typeof args.soul === 'string' ? args.soul : '';
  const images = await castSourceAssets(ctx.sessionId, args.image_asset_ids, 'image_asset_ids', cast.IMAGE_EXTENSIONS, 6);
  const voice = await castSourceAsset(ctx.sessionId, args.voice_asset_id, 'voice_asset_id', cast.VOICE_EXTENSIONS);
  ctx.emit({ type: 'tool_start', tool: 'create_cast_member', label: `Erstelle Cast-Mitglied: ${shorten(name, 60)}` });

  const member = await cast.createMember(folder, { name, soul });
  try {
    for (const asset of images) {
      await cast.addMemberAsset(member.id, {
        kind: 'image',
        sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), asset.file),
        filename: asset.file
      });
    }
    if (voice) {
      await cast.addMemberAsset(member.id, {
        kind: 'voice',
        sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), voice.file),
        filename: voice.file
      });
    }
  } catch (err) {
    await cast.removeMember(member.id).catch(() => {});
    throw err;
  }
  const saved = await cast.readMember(member.id);
  return {
    toolResult: `Cast-Mitglied ${saved.name} erstellt (ID ${saved.id}, ${saved.images.length} Bild(er), Stimme ${saved.voice ? 'vorhanden' : 'noch offen'}).`,
    inject: []
  };
}

async function runUpdateCastMember(ctx, args) {
  const folder = await requireProjectFolder(ctx);
  const query = args.member_id || args.name;
  if (!query) throw new Error('member_id oder eindeutiger name fehlt');
  const memberId = await cast.resolveMemberId(folder, query);
  const current = await cast.readMember(memberId);
  const images = await castSourceAssets(ctx.sessionId, args.add_image_asset_ids, 'add_image_asset_ids', cast.IMAGE_EXTENSIONS, 6);
  if (current.images.length + images.length > cast.MAX_IMAGES) {
    throw new Error(`Pro Cast-Mitglied sind maximal ${cast.MAX_IMAGES} Bilder erlaubt`);
  }
  const voice = await castSourceAsset(ctx.sessionId, args.voice_asset_id, 'voice_asset_id', cast.VOICE_EXTENSIONS);
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(args, 'new_name')) patch.name = args.new_name;
  if (Object.prototype.hasOwnProperty.call(args, 'soul')) patch.soul = args.soul;
  if (!Object.keys(patch).length && !images.length && !voice) throw new Error('Keine Aenderung angegeben');
  ctx.emit({ type: 'tool_start', tool: 'update_cast_member', label: `Aktualisiere Cast-Mitglied: ${shorten(current.name, 60)}` });

  if (Object.keys(patch).length) await cast.updateMember(memberId, patch);
  for (const asset of images) {
    await cast.addMemberAsset(memberId, {
      kind: 'image',
      sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), asset.file),
      filename: asset.file
    });
  }
  if (voice) {
    await cast.addMemberAsset(memberId, {
      kind: 'voice',
      sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), voice.file),
      filename: voice.file
    });
  }
  const saved = await cast.readMember(memberId);
  return {
    toolResult: `Cast-Mitglied ${saved.name} aktualisiert (ID ${saved.id}, ${saved.images.length} Bild(er), Stimme ${saved.voice ? 'vorhanden' : 'noch offen'}).`,
    inject: []
  };
}

const CAST_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

async function runImportCastAsset(ctx, args) {
  const folder = await requireProjectFolder(ctx);
  const memberId = await cast.resolveMemberId(folder, requiredString(args.member, 'member'));
  const member = await cast.readMember(memberId);
  const selector = requiredString(args.asset, 'asset');
  let filename;
  let kind;
  if (selector.toLowerCase() === 'voice') {
    if (!member.voice) throw new Error(`${member.name} hat noch keinen Voice-Master.`);
    filename = member.voice;
    kind = path.extname(filename).toLowerCase() === '.mp4' ? 'video' : 'audio';
  } else if (selector.toLowerCase().startsWith('image:')) {
    const requested = selector.slice(selector.indexOf(':') + 1).trim();
    if (/^\d+$/.test(requested)) filename = member.images[Number.parseInt(requested, 10) - 1];
    else filename = member.images.find((file) => file.toLowerCase() === requested.toLowerCase());
    if (!filename) throw new Error(`Cast-Bild ${requested} bei ${member.name} nicht gefunden.`);
    kind = 'image';
  } else {
    throw new Error("asset muss 'voice' oder 'image:<index|dateiname>' sein");
  }

  ctx.emit({ type: 'tool_start', tool: 'import_cast_asset', label: `Importiere Cast-Datei: ${member.name} / ${filename}` });
  const buffer = await cast.readMemberAsset(memberId, filename);
  const result = await storeImportedSessionAsset(ctx, {
    buffer,
    filename,
    prompt: `Cast-Import: ${member.name} / ${filename}`,
    sourceLabel: 'Cast-Datei',
    mimeType: CAST_IMAGE_MIME[path.extname(filename).toLowerCase()] || '',
    kind
  });
  if (kind === 'image') {
    result.toolResult += ` Nutze ${result.asset.id} in reference_asset_ids fuer das Aussehen von ${member.name}.`;
  } else if (kind === 'video') {
    result.toolResult += ` Nutze ${result.asset.id} in reference_video_asset_ids fuer Aussehen und Stimme von ${member.name}.`;
  } else {
    result.toolResult += ` Nutze ${result.asset.id} in reference_audio_asset_ids fuer die Stimme von ${member.name}.`;
  }
  return result;
}

module.exports = {
  runGenerateImage,
  runEditImage,
  runImportGtsAsset,
  runCreateBranding,
  runUpdateBranding,
  runAddBrandingAsset,
  runImportBrandingAsset,
  runCreateCastMember,
  runUpdateCastMember,
  runImportCastAsset,
  createImage
};
