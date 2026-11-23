'use strict';

// Real JSON-RPC over HTTP in a private app copy. No provider or website host is contacted.
const assert = require('assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const { createIsolatedApp } = require('./support/isolated-app');

const OWNER = 'ada@staff.example.com';
const OTHER = 'bea@staff.example.com';
const viewer = { active: true, identified: true, admin: false, email: OWNER, kind: 'internal' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const READ = ['get_influencer', 'get_influencer_site', 'list_influencers'];
const WRITE = ['add_influencer_image', 'add_influencer_site_item', 'create_influencer', 'publish_influencer_site', 'remove_influencer_site_item', 'update_influencer', 'update_influencer_site'];
function guardFetch() {
  const original = global.fetch;
  const attempts = [];
  global.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      attempts.push(url);
      return Promise.reject(new Error('Network access refused in the test'));
    }
    return original(input, init);
  };
  return { attempts, restore() { global.fetch = original; } };
}
function fakeHost() {
  return { active: false, calls: [], sites: [], block: null,
    enabled() { return this.active; },
    status() { return { connected: true }; },
    async call(name, args) {
      this.calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (name === 'connected_site') return { creation_permission: { can_create_site: true }, sites: this.sites };
      if (name === 'check_subdomain') return { result: { available: true } };
      if (name === 'claim_subdomain') {
        if (this.block) await this.block;
        this.sites.push({ slug: args.slug, full_domain: `${args.slug}.host.example` });
        return { claimed: true, slug: args.slug };
      }
      return { ok: true };
    }
  };
}
async function main() {
  const guard = guardFetch();
  const iso = await createIsolatedApp({ env: { ADMIN_EMAILS: 'admin@example.com', SUPERADMIN_EMAILS: '', INTERNAL_EMAIL_DOMAINS: 'staff.example.com',
    WEBSITE_HOST_MCP_URL: '', PUBLIC_BASE_URL: 'https://creator.example.com/studio', OPENROUTER_API_KEY: '', FAL_KEY: '', ELEVENLABS_API_KEY: '' } });
  let server;
  try {
    await iso.listen();
    await iso.request('/api/me', { as: OWNER });
    await iso.request('/api/me', { as: OTHER });
    const keys = iso.load('lib/mcp/keys').defaultStore;
    const inf = iso.load('lib/influencers');
    const pages = iso.load('lib/influencer-pages');
    const sessions = iso.load('lib/store');
    const wfStore = iso.load('lib/nodes/workflows-store').defaultStore;
    const host = fakeHost();
    const mcp = iso.load('lib/mcp').createMcp({ keys, websiteHost: host, sweepUploads: false,
      env: { PUBLIC_BASE_URL: 'https://creator.example.com/studio' }, limiter: { take: () => ({ allowed: true }), reset() {} } });
    const app = express();
    mcp.mount(app);
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    let rpcId = 0;
    const rpc = async (secret, method, params) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      assert.ok(value.result, JSON.stringify(value));
      return value.result;
    };
    const tool = (secret, name, args = {}) => rpc(secret, 'tools/call', { name, arguments: args });
    const ok = async (secret, name, args = {}) => {
      const result = await tool(secret, name, args);
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
      return result.structuredContent;
    };
    const refused = async (secret, name, args = {}, pattern = /./) => {
      const result = await tool(secret, name, args);
      assert.equal(result.isError, true, `${name} should fail: ${JSON.stringify(result)}`);
      assert.match(result.content[0].text, pattern);
    };
    const reader = keys.create({ owner: OWNER, name: 'Read', right: 'read' });
    const starter = keys.create({ owner: OWNER, name: 'Start', right: 'start' });
    const otherKey = keys.create({ owner: OTHER, name: 'Other', right: 'start' });
    const read = reader.secret, start = starter.secret, other = otherKey.secret;
    const upload = (secret, buffer = PNG, filename = 'look.png', mime_type = 'image/png') => ok(secret, 'upload_asset', { filename, mime_type, data_base64: buffer.toString('base64') });

    // Rights are checked before schema validation and before any host call.
    const readList = (await rpc(read, 'tools/list')).tools;
    assert.deepEqual(readList.filter((item) => [...READ, ...WRITE].includes(item.name)).map((item) => item.name), READ);
    assert.ok(readList.filter((item) => READ.includes(item.name)).every((item) => item.annotations.readOnlyHint));
    const startList = (await rpc(start, 'tools/list')).tools;
    assert.deepEqual(startList.filter((item) => [...READ, ...WRITE].includes(item.name)).map((item) => item.name), [...READ, ...WRITE].sort());
    const publishDef = startList.find((item) => item.name === 'publish_influencer_site');
    assert.equal(publishDef.inputSchema.required.includes('confirm'), false);
    assert.deepEqual(publishDef.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.equal(startList.find((item) => item.name === 'remove_influencer_site_item').annotations.destructiveHint, true);
    for (const name of WRITE) await refused(read, name, {}, /may only read/);
    assert.equal(host.calls.length, 0);
    assert.equal((await ok(read, 'get_influencer', { influencer_id: 'claudia' })).editable, false);
    const list = await ok(read, 'list_influencers');
    assert.equal(list.max_owned, inf.MAX_OWNED_INFLUENCERS);
    assert.equal(list.owned, 0);
    assert.equal(list.influencers[0].image_count > 0, true);

    // Consent, ownership, schema and the shared HTTP view.
    const createArgs = { name: 'Nova Test', full: 'An invented figure', tagline: 'First', voice: { voice_id: '', name: 'Voice', description: 'Calm' } };
    await refused(start, 'create_influencer', createArgs, /consent: true/);
    await refused(start, 'create_influencer', { ...createArgs, consent: false }, /INFLUENCER_CONSENT_REQUIRED/);
    assert.equal(await inf.countOwnedBy(OWNER), 0);
    const created = await ok(start, 'create_influencer', { ...createArgs, consent: true });
    const id = created.id, args = { influencer_id: id };
    assert.equal(created.owner, OWNER);
    assert.equal(created.own, true);
    assert.equal(created.voice.voice_id, '');
    assert.equal((await inf.readInfluencer(id)).owner, OWNER);
    assert.equal((await ok(read, 'list_influencers')).owned, 1);
    const updated = await ok(start, 'update_influencer', { ...args, tagline: 'Updated', style: 'Blue', open: true, voice: { name: 'New voice' } });
    assert.equal(updated.tagline, 'Updated');
    assert.equal(updated.style, 'Blue');
    assert.equal(updated.voice.name, 'New voice');
    assert.equal(updated.open, true);
    for (const patch of [{ claim: true }, { owner: OTHER }, { unknown: 'x' }, { voice: { voiceId: 'x' } }]) await refused(start, 'update_influencer', { ...args, ...patch }, /not a known property/);
    await refused(start, 'update_influencer', { influencer_id: 'claudia', tagline: 'No' }, /INFLUENCER_READONLY/);
    await refused(start, 'add_influencer_image', { influencer_id: 'claudia', asset_id: 'missing' }, /INFLUENCER_READONLY/);
    const foreign = await inf.createInfluencer({ name: 'Foreign', full: 'Private identity' }, { viewer: { ...viewer, email: OTHER }, consent: true });
    const foreignArgs = { influencer_id: foreign.id };
    for (const name of ['get_influencer', 'update_influencer', 'get_influencer_site', 'publish_influencer_site']) await refused(start, name, { ...foreignArgs, ...(name === 'publish_influencer_site' ? { confirm: true } : {}) }, /INFLUENCER_NOT_FOUND/);
    await inf.updateInfluencer(foreign.id, { open: true });
    await pages.writeSite(foreign.id, (site) => { site.allowedEmails = ['private@example.com']; }, { viewer: { ...viewer, email: OTHER } });
    const open = await ok(read, 'get_influencer', foreignArgs);
    assert.equal(open.editable, false);
    assert.equal(open.own, false);
    assert.equal(open.owner, null);
    assert.equal(open.site, undefined);
    assert.deepEqual(Object.keys(open.consent), ['confirmed_at']);
    const httpView = await iso.request(`/api/influencers/${foreign.id}`, { as: OWNER });
    assert.equal(httpView.body.owner, null);
    assert.equal(httpView.body.site, undefined);
    assert.deepEqual(Object.keys(httpView.body.consent), ['confirmedAt']);
    await refused(start, 'update_influencer', { ...foreignArgs, tagline: 'No' }, /INFLUENCER_FORBIDDEN/);
    await refused(start, 'get_influencer_site', foreignArgs, /INFLUENCER_FORBIDDEN/);

    // Images must be a finished upload of this key, never an arbitrary asset or path.
    const image = await upload(start);
    // Asset ids are local to a session (both keys start at upload-001); use a foreign id absent here.
    await upload(other);
    await upload(other);
    const otherImage = await upload(other);
    const added = await ok(start, 'add_influencer_image', { ...args, asset_id: image.asset_id, filename: 'portrait.png' });
    assert.deepEqual(added.images, ['portrait.png']);
    await refused(start, 'add_influencer_image', { ...args, asset_id: otherImage.asset_id }, /not uploaded with this key/);
    await refused(start, 'add_influencer_image', { ...args, asset_id: 'invented' }, /not uploaded with this key/);
    await refused(start, 'add_influencer_image', { ...args, asset_id: image.asset_id, path: '/tmp/image.png' }, /not a known property/);
    const text = await upload(start, Buffer.from('Plain text'), 'notes.txt', 'text/plain');
    await refused(start, 'add_influencer_image', { ...args, asset_id: text.asset_id }, /INFLUENCER_IMAGE_INVALID/);
    await refused(start, 'add_influencer_image', { ...args, asset_id: image.asset_id, filename: 'wrong.jpg' }, /INFLUENCER_IMAGE_INVALID/);

    // The host can be off without hiding the influencer or throwing for the site status.
    const off = await ok(read, 'get_influencer_site', args);
    assert.equal(off.host.enabled, false);
    assert.equal(off.site, null);
    assert.equal(off.preview_url, `https://creator.example.com/studio/api/influencers/${id}/site/preview/`);
    host.active = true;
    const initial = await ok(read, 'get_influencer_site', args);
    assert.equal(initial.host.can_create, true);
    assert.equal(initial.max_items, 60);
    await refused(start, 'update_influencer_site', { ...args, visibility: 'protected' }, /SITE_ACCESS_REQUIRED/);
    const draft = await ok(start, 'update_influencer_site', { ...args, slug: 'nova-test', about: 'About Nova', lang: 'en', usage: 'open', visibility: 'protected', allowed_emails: ['reader@example.com'] });
    assert.equal(draft.site.slug, 'nova-test');
    assert.equal(draft.site.about, 'About Nova');
    assert.deepEqual(draft.site.allowed_emails, ['reader@example.com']);
    await refused(start, 'update_influencer_site', { ...args, made_up: true }, /not a known property/);
    const add = (source, extra = {}) => ok(start, 'add_influencer_site_item', { ...args, title: 'Work', description: 'A test work', ...source, ...extra });
    for (const source of [{}, { youtube: 'https://youtu.be/9kqGUuzK5_s', asset_id: image.asset_id }, { workflow_id: 'missing' }]) {
      await refused(start, 'add_influencer_site_item', { ...args, title: 'Bad', description: '', ...source }, /exactly one source/);
    }
    const youtube = await add({ youtube: 'https://youtu.be/9kqGUuzK5_s' });
    assert.equal(youtube.item.kind, 'youtube');
    const uploadItem = await add({ asset_id: image.asset_id });
    assert.equal(uploadItem.item.kind, 'image', 'an upload ledger entry is accepted by the shared page service');
    assert.equal(uploadItem.item.file, undefined);
    await refused(start, 'add_influencer_site_item', { ...args, title: 'No', description: '', asset_id: otherImage.asset_id }, /not uploaded with this key/);

    // A real service check precedes resolving the workflow's backing session; pages checks that session again.
    const ownWorkflow = (await wfStore.createWorkflow({ name: 'Own workflow', owner: OWNER })).workflow;
    const foreignWorkflow = (await wfStore.createWorkflow({ name: 'Foreign workflow', owner: OTHER })).workflow;
    const resultAsset = async (workflow) => {
      const file = 'result.png';
      await fsp.writeFile(path.join(sessions.sessionAssetDir(workflow.sessionId), file), PNG);
      await sessions.writeLedger(workflow.sessionId, [{ id: 'result-image', kind: 'image', file, createdAt: '2026-11-23T12:00:00Z' }]);
    };
    await resultAsset(ownWorkflow);
    await resultAsset(foreignWorkflow);
    const result = await add({ workflow_id: ownWorkflow.id, asset_id: 'result-image' });
    assert.equal(result.item.kind, 'image');
    await refused(start, 'add_influencer_site_item', { ...args, title: 'No', description: '', workflow_id: foreignWorkflow.id, asset_id: 'result-image' }, /Not found/);
    await refused(start, 'add_influencer_site_item', { ...args, title: 'No', description: '', workflow_id: ownWorkflow.id, asset_id: 'missing' }, /SITE_NOT_FOUND/);
    await sessions.updateSessionSharing(ownWorkflow.sessionId, { owner: OTHER, shareMode: 'private' });
    await refused(start, 'add_influencer_site_item', { ...args, title: 'No', description: '', workflow_id: ownWorkflow.id, asset_id: 'result-image' }, /SITE_NOT_FOUND/);
    const uploadSession = mcp.uploads.peek(starter.key.id);
    await sessions.updateSessionSharing(uploadSession, { owner: OTHER, shareMode: 'private' });
    await refused(start, 'add_influencer_site_item', { ...args, title: 'No', description: '', asset_id: image.asset_id }, /not uploaded with this key/);
    await sessions.updateSessionSharing(uploadSession, { owner: OWNER, shareMode: 'private' });
    const allItems = result.site.items.map(({ id }) => ({ id }));
    const reordered = await ok(start, 'update_influencer_site', { ...args, items: allItems.reverse() });
    assert.deepEqual(reordered.site.items.map((item) => item.id), allItems.map((item) => item.id));
    await refused(start, 'update_influencer_site', { ...args, items: allItems.slice(1) }, /SITE_INVALID/);
    await ok(start, 'remove_influencer_site_item', { ...args, item_id: uploadItem.item.id });
    assert.equal((await ok(read, 'get_influencer_site', args)).site.items.length, 2);

    // Publish a page without local images so the test needs no ffmpeg, public media URL or real host.
    const publisher = await ok(start, 'create_influencer', { name: 'Published figure', full: 'Invented', consent: true });
    const pubArgs = { influencer_id: publisher.id };
    await ok(start, 'update_influencer_site', { ...pubArgs, slug: 'published-figure' });
    await ok(start, 'add_influencer_site_item', { ...pubArgs, title: 'Film', description: '', youtube: 'https://youtu.be/9kqGUuzK5_s' });
    host.calls.length = 0;
    await refused(start, 'publish_influencer_site', pubArgs, /preview_url.*confirm: true/);
    await refused(start, 'publish_influencer_site', { ...pubArgs, confirm: false }, /SITE_CONFIRM_PUBLIC_REQUIRED/);
    await refused(read, 'publish_influencer_site', { ...pubArgs, confirm: true }, /may only read/);
    await refused(start, 'publish_influencer_site', { ...pubArgs, confirm: true, wait_seconds: 31 }, /at most 30/);
    assert.equal(host.calls.length, 0, 'nothing reaches the host without valid explicit confirmation');
    let release;
    host.block = new Promise((resolve) => { release = resolve; });
    const publishing = await ok(start, 'publish_influencer_site', { ...pubArgs, confirm: true, wait_seconds: 0 });
    assert.equal(publishing.state, 'running');
    assert.equal(publishing.url, null);
    assert.match(publishing.message, /get_influencer_site/);
    assert.equal((await ok(read, 'get_influencer_site', pubArgs)).job.state, 'running');
    release();
    host.block = null;
    // Join the existing job through the library's status while allowing the HTTP server to make progress.
    const deadline = Date.now() + 5000;
    let published;
    do {
      published = await ok(read, 'get_influencer_site', pubArgs);
      if (published.job.state === 'done') break;
      assert.ok(Date.now() < deadline, 'publishing finished');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
    assert.equal(published.published, true);
    assert.deepEqual(published.job.errors, []);
    assert.equal(published.site.url, 'https://published-figure.host.example/');
    assert.equal(published.job.url, published.site.url);
    assert.ok(host.calls.some((call) => call.name === 'publish_site'));
    assert.deepEqual(host.calls.find((call) => call.name === 'claim_subdomain').args.editor_emails, [OWNER]);
    const again = await ok(start, 'publish_influencer_site', { ...pubArgs, confirm: true, wait_seconds: 5 });
    assert.equal(again.state, 'done');
    assert.equal(again.url, published.site.url);
    assert.deepEqual(again.errors, []);

    // Known host errors use safe detail; unknown errors are rethrown by the handler.
    const { createInfluencerTools } = iso.load('lib/mcp/influencer-tools');
    const throwingHost = { enabled: () => { throw new Error('unexpected test failure'); } };
    const tools = createInfluencerTools({ uploads: mcp.uploads, service: iso.load('lib/nodes/run-service').runService(), accounting: mcp.accounting, host: throwingHost });
    await assert.rejects(tools.find((item) => item.name === 'get_influencer_site').handler(args, { viewer, key: starter.key }), /unexpected test failure/);
    const brokenHost = { enabled: () => true, status: () => ({ connected: true }), call: async () => { throw Object.assign(new Error('secret'), { code: 'HOST_AUTH' }); } };
    const broken = createInfluencerTools({ uploads: mcp.uploads, accounting: mcp.accounting, host: brokenHost });
    await assert.rejects(broken.find((item) => item.name === 'publish_influencer_site').handler({ ...pubArgs, confirm: true }, { viewer, key: starter.key }), (err) => err.name === 'ToolError' && /HOST_AUTH/.test(err.message) && !/secret/.test(err.message));
    assert.deepEqual(guard.attempts, []);
  } finally {
    if (server) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await iso.cleanup();
    guard.restore();
  }
  console.log('test-mcp-influencer-tools.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
