'use strict';

// Agent access uses the same viewer-based services as the app; only upload provenance and argument names live here.
const fsp = require('fs/promises');
const path = require('path');
const influencers = require('../influencers');
const pages = require('../influencer-pages');
const sessions = require('../store');
const access = require('../access');
const assets = require('../nodes/assets');
const workflows = require('../nodes/workflows-store');
const { defaultHost } = require('../rtk-host');
const { MAX_ITEMS } = require('../influencer-site');
const { ToolError, defineTool } = require('./tools');
const { linkUrl } = require('./links');

const idSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const string = (maxLength) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const textFields = Object.fromEntries(Object.entries({ name: 60, tagline: 300, full: 1500, short: 400, looks: 1000, face: 400, never: 400, credit: 200, style: 1000 }).map(([field, max]) => [field, string(max)]));
const voiceSchema = object({ voice_id: string(200), name: string(80), description: string(400) });
const itemFields = { id: idSchema, title: string(120), description: string(1200) };
const siteFields = {
  slug: string(40), visibility: { type: 'string', enum: ['public', 'protected'] },
  allowed_emails: { type: 'array', maxItems: 50, items: string(320) },
  allowed_domains: { type: 'array', maxItems: 20, items: string(253) },
  lang: { type: 'string', enum: ['de', 'en', 'es'] }, about: string(2000), usage: { type: 'string', enum: ['open', 'closed'] },
  items: { type: 'array', maxItems: MAX_ITEMS, items: object(itemFields, ['id']) }
};
const snake = (value) => Array.isArray(value) ? value.map(snake) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), snake(entry)])) : value;
function figureInput(args) {
  const { influencer_id, consent, ...fields } = args;
  if (fields.voice) {
    const { voice_id, ...rest } = fields.voice;
    fields.voice = { ...rest, ...(voice_id !== undefined ? { voiceId: voice_id } : {}) };
  }
  return fields;
}
const previewUrl = (context, id) => linkUrl(context.publicBase, `/api/influencers/${encodeURIComponent(id)}/site/preview/`);
const itemView = ({ id, kind, title, description, date }) => ({ id, kind, title, description, date });
function siteResult(result, context, id) {
  const site = result.site;
  return {
    host: { enabled: result.host.enabled, connected: result.host.connected, can_create: result.host.canCreate },
    site: site ? { slug: site.slug, visibility: site.visibility, allowed_emails: site.allowedEmails, allowed_domains: site.allowedDomains,
      lang: site.lang, about: site.about, usage: site.usage, items: site.items.map(itemView),
      published_at: site.publishedAt, url: site.url } : null,
    published: Boolean(result.published), max_items: result.maxItems || MAX_ITEMS, job: snake(result.job), preview_url: previewUrl(context, id)
  };
}

function createInfluencerTools({ uploads, service, accounting, host = defaultHost, workflowStore = workflows.defaultStore } = {}) {
  const svc = typeof service === 'function' ? service : () => service;
  // Resolve only within the current key's hidden upload session; no caller-supplied file or session path is accepted.
  async function uploadAsset(context, assetId) {
    const sessionId = uploads.peek(context.key.id);
    const missing = () => new ToolError('This asset was not uploaded with this key (INFLUENCER_ASSET_NOT_FOUND). Call upload_asset and use its asset_id.');
    if (!sessionId) throw missing();
    if (!access.canUse(await sessions.readSessionAccess(sessionId), context.viewer)) throw missing();
    const entry = (await sessions.readLedger(sessionId)).find((item) => item.id === assetId && item.kind === 'upload' && !item.pending);
    if (!entry || !assets.isSafeFilename(entry.file) || entry.file.includes('..')) throw missing();
    return { sessionId, entry };
  }
  function tool(name, description, right, properties, required, handler, annotations = {}) {
    return defineTool({ name, description, right, inputSchema: object(properties, required), annotations,
      handler: async (args, context) => {
        const run = async () => {
          try { return await handler(args, context); } catch (err) {
            if (/^(INFLUENCER_|SITE_|HOST_)/.test(err?.code || '')) {
              const detail = /^(SITE_|HOST_)/.test(err.code) ? pages.safeMessage(err) : err.message;
              throw new ToolError(`The influencer request could not be completed (${err.code}): ${detail}`);
            }
            throw err;
          }
        };
        return right === 'start' ? accounting.serialize(context.key.id, run) : run();
      }
    });
  }
  const figure = (id, context) => influencers.readInfluencerView(id, context.viewer).then(snake);
  const site = async (id, context) => siteResult(await pages.readSite(id, { viewer: context.viewer, host }), context, id);
  return [
    tool('list_influencers', 'List the influencers this person can use, including the built-in Claudia, and the ownership limit.', 'read', {}, [], async (_args, { viewer }) => ({
      influencers: snake(await influencers.listInfluencers({ viewer })), max_owned: influencers.MAX_OWNED_INFLUENCERS, owned: await influencers.countOwnedBy(viewer.email)
    })),
    tool('get_influencer', 'Read an influencer this person can use, with identity texts, reference image filenames, style and voice. Private settings are only shown to editors.', 'read', { influencer_id: idSchema }, ['influencer_id'],
      (args, context) => figure(args.influencer_id, context)),
    tool('create_influencer', 'Create an influencer owned by this person. Before calling, ask the person to confirm that the figure does not depict a real person without their consent; then pass consent: true.', 'start',
      { ...textFields, voice: voiceSchema, consent: { type: 'boolean' } }, ['name', 'full'], async (args, context) => {
        if (args.consent !== true) throw new ToolError('Ask the person to confirm that the figure does not depict a real person without their consent, then pass consent: true (INFLUENCER_CONSENT_REQUIRED).');
        const created = await influencers.createInfluencer(figureInput(args), { viewer: context.viewer, consent: true });
        return figure(created.id, context);
      }),
    tool('update_influencer', 'Change identity texts, style, voice or open use of an editable influencer. Claudia is read-only. Ownership claims are only available in the app.', 'start',
      { influencer_id: idSchema, ...textFields, voice: voiceSchema, open: { type: 'boolean' } }, ['influencer_id'], async (args, context) => {
        await influencers.readEditableInfluencer(args.influencer_id, context.viewer);
        await influencers.updateInfluencer(args.influencer_id, figureInput(args), { viewer: context.viewer });
        return figure(args.influencer_id, context);
      }),
    tool('add_influencer_image', 'Add a reference image uploaded with this same key through upload_asset. PNG, JPEG or WebP only, at most 15 MB and six images per influencer.', 'start',
      { influencer_id: idSchema, asset_id: idSchema, filename: string(200) }, ['influencer_id', 'asset_id'], async (args, context) => {
        await influencers.readEditableInfluencer(args.influencer_id, context.viewer);
        const { sessionId, entry } = await uploadAsset(context, args.asset_id);
        if (assets.typeFromLedgerEntry(entry) !== 'image') throw new ToolError('The uploaded asset must be a PNG, JPEG or WebP image (INFLUENCER_IMAGE_INVALID).');
        const root = await fsp.realpath(sessions.sessionAssetDir(sessionId));
        const file = path.join(root, entry.file);
        let stat;
        try {
          stat = await fsp.lstat(file);
          if (!stat.isFile() || !(await fsp.realpath(file)).startsWith(`${root}${path.sep}`)) throw new ToolError('The uploaded image is unavailable (INFLUENCER_IMAGE_INVALID).');
        } catch (err) {
          if (err.code === 'ENOENT') throw new ToolError('The uploaded image is unavailable (INFLUENCER_IMAGE_INVALID).');
          throw err;
        }
        if (stat.size > influencers.MAX_IMAGE_BYTES) throw new ToolError('The image exceeds 15 MB (INFLUENCER_IMAGE_TOO_LARGE).');
        await influencers.saveInfluencerImage(args.influencer_id, { filename: args.filename || entry.file, buffer: await fsp.readFile(file) });
        return figure(args.influencer_id, context);
      }),
    tool('get_influencer_site', 'Read the editable influencer page, host availability and publishing progress. preview_url opens the preview in the app and requires this person to log in.', 'read',
      { influencer_id: idSchema }, ['influencer_id'], (args, context) => site(args.influencer_id, context)),
    tool('update_influencer_site', 'Edit the influencer page draft. Protected pages need allowed emails or domains. To reorder or edit items, provide every existing item id exactly once.', 'start',
      { influencer_id: idSchema, ...siteFields }, ['influencer_id'], async (args, context) => {
        const { influencer_id, allowed_emails, allowed_domains, ...patch } = args;
        if (allowed_emails !== undefined) patch.allowedEmails = allowed_emails;
        if (allowed_domains !== undefined) patch.allowedDomains = allowed_domains;
        return siteResult(await pages.updateSite(influencer_id, patch, { viewer: context.viewer, host }), context, influencer_id);
      }),
    tool('add_influencer_site_item', 'Add work to an editable page: exactly one YouTube link, an asset_id uploaded with this key, or workflow_id plus asset_id from a workflow this person can access.', 'start',
      { influencer_id: idSchema, title: string(120), description: string(1200), youtube: string(2000), asset_id: idSchema, workflow_id: idSchema }, ['influencer_id', 'title', 'description'], async (args, context) => {
        await influencers.readEditableInfluencer(args.influencer_id, context.viewer);
        if ((args.youtube !== undefined && (args.asset_id !== undefined || args.workflow_id !== undefined)) || (args.youtube === undefined && !args.asset_id)) {
          throw new ToolError('Provide exactly one source: youtube, asset_id from this key, or workflow_id together with asset_id (SITE_INVALID).');
        }
        const input = { title: args.title, description: args.description };
        if (args.youtube !== undefined) input.youtube = args.youtube;
        else {
          if (args.workflow_id) {
            // Check through the run service first; the store's backing session is never taken from arguments.
            await svc().describeWorkflow(context.viewer, args.workflow_id);
            input.sessionId = (await workflowStore.readWorkflow(args.workflow_id)).sessionId;
          } else input.sessionId = (await uploadAsset(context, args.asset_id)).sessionId;
          input.assetId = args.asset_id;
        }
        const result = await pages.addItem(args.influencer_id, input, { viewer: context.viewer, host });
        return { item: itemView(result.item), ...(await site(args.influencer_id, context)) };
      }),
    tool('remove_influencer_site_item', 'Remove one work item from an editable influencer page draft. Publish the draft to update the hosted page.', 'start',
      { influencer_id: idSchema, item_id: idSchema }, ['influencer_id', 'item_id'], async (args, context) => {
        await pages.removeItem(args.influencer_id, args.item_id, { viewer: context.viewer, host });
        return site(args.influencer_id, context);
      }, { destructiveHint: true }),
    tool('publish_influencer_site', 'Publish the influencer page to the external website host. First show the person preview_url from get_influencer_site and the intended address, and wait for their explicit yes. Only then call with confirm: true. With visibility: public the page is visible to everyone on the Internet.', 'start',
      { influencer_id: idSchema, confirm: { type: 'boolean' }, wait_seconds: { type: 'number', minimum: 0, maximum: 30 } }, ['influencer_id'], async (args, context) => {
        await influencers.readEditableInfluencer(args.influencer_id, context.viewer);
        if (args.confirm !== true) throw new ToolError('Show the person the preview_url and intended address, wait for their explicit yes, then call with confirm: true. A public page is visible to everyone on the Internet (SITE_CONFIRM_PUBLIC_REQUIRED).');
        const started = await pages.startPublish(args.influencer_id, { viewer: context.viewer, user: context.viewer.email, host, confirmPublic: true });
        let job = started.job;
        if (args.wait_seconds > 0) {
          let timer;
          try {
            job = await Promise.race([started.finished, new Promise((resolve) => { timer = setTimeout(() => resolve(null), args.wait_seconds * 1000); })]) || (await pages.readSite(args.influencer_id, { viewer: context.viewer, host })).job;
          } finally { clearTimeout(timer); }
        }
        const url = job.url || (job.state === 'done' ? (await pages.readSite(args.influencer_id, { viewer: context.viewer, host })).site?.url : null) || null;
        return { state: job.state, step: job.step, done: job.done, total: job.total, errors: snake(job.errors), url,
          ...(!url ? { message: 'The address is not assigned yet. Call get_influencer_site to check publishing progress and the public URL.' } : {}) };
      }, { destructiveHint: false, idempotentHint: false, openWorldHint: true })
  ];
}

module.exports = { createInfluencerTools };
