'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { classify, createStrikes, createBlockGuard } = require('../lib/strikes');
const { createMonitor, createJobsReader } = require('../lib/admin-monitoring');
const { capacityVerdict, createActivity } = require('../lib/admin-activity');
const { createKeyStore } = require('../lib/mcp/keys');
const { createIsolatedApp } = require('./support/isolated-app');
const DAY = 86400000;
const ALICE = 'alice@example.com', ADMIN = 'admin@example.com', BOSS = 'boss@example.com';
let at = Date.parse('2026-11-01T12:00:00Z');
const isoTime = (offset = 0) => new Date(at + offset).toISOString();
const run = (id, patch = {}) => ({ workflowId: 'wf', id: String(id), user: ALICE, status: 'failed', startedAt: isoTime(-2000), finishedAt: isoTime(-1000), codes: ['PLANNER_CONTENT_FILTER'], error: 'private provider text', prompt: 'private prompt', ...patch });

function classification() {
  // A known refusal code wins over the text: the message of a blocked image quotes the person's own prompt line.
  assert.deepEqual(classify({ code: 'IMAGE_SAFETY_EXHAUSTED', message: 'Image 1 blocked; line: a timeout, cancelled, echte Person; attempts: a' }), { strike: true, code: 'IMAGE_SAFETY_EXHAUSTED' });
  assert.equal(classify({ code: 'VIDEO_REAL_PERSON', message: 'content filter' }), null);
  assert.equal(classify({ code: 'ETIMEDOUT', message: 'nsfw' }), null);
  for (const code of ['PLANNER_CONTENT_FILTER', 'IMAGE_SAFETY_EXHAUSTED', 'FAL_CONTENT_CHECKER']) assert.deepEqual(classify({ code }), { strike: true, code });
  for (const message of ['content filter', 'content_policy_violation', 'flagged by moderation', 'Request blocked for safety', 'Request refused for safety', 'nsfw', 'sensitive content', 'Higgsfield hat den Auftrag durch den Inhaltsfilter abgelehnt.', 'Google: Gemini could not generate an image (IMAGE_SAFETY)', 'Google: Gemini could not generate an image (PROHIBITED_CONTENT)', 'Google: Gemini could not generate an image (SAFETY)', 'Magnific MCP rejected the request: flagged by moderation', 'fal HTTP 422: content_checker rejected the image']) {
    assert.equal(classify({ message })?.code, 'CONTENT_REFUSED', message);
    assert.equal(classify({ message, code: 'UNKNOWN' })?.strike, true, message);
  }
  for (const code of ['VIDEO_REAL_PERSON', 'VIDEO_REAL_PERSON_JOB', 'VIDEO_MODEL_REFUSED', 'ip_detected', 'BUDGET_EXHAUSTED', 'BUDGET_INSUFFICIENT', 'INVALID_FORMAT', 'VALIDATION_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'ABORTED', 'CANCELLED', 'VIDEO_FRAME_RATIO', 'VIDEO_FRAME_UNREADABLE', 'FLUX_MAX_KEYFRAME_TIMES_ORDER', 'INVALID_REQUEST', 'InputImageSensitiveContentDetected.PrivacyInformation', 'ECONNRESET', 'ETIMEDOUT', 'SERVER_RESTARTED']) assert.equal(classify({ code, message: 'sensitive content' }), null, code);
  for (const message of ['BUDGET_EXHAUSTED: content filter', 'VIDEO_MODEL_REFUSED: sensitive content', 'InputImageSensitiveContentDetected.PrivacyInformation: sensitive content', 'input may contain real person: content filter', 'Server restarted during the run', 'Higgsfield hat den Auftrag wegen einer erkannten IP-/Markenreferenz abgelehnt.', 'network error', 'request timed out', 'aborted', 'invalid parameter', 'Google: Gemini could not generate an image (IMAGE_OTHER)', 'Magnific MCP rejected the request: too many requests', 'Magnific MCP rejected the request: invalid format']) assert.equal(classify({ message }), null, message);
}

async function journals(root) {
  const env = {};
  const dataDir = path.join(root, 'strikes');
  const deps = { dataDir, now: () => at, env, isAdmin: (email) => [ADMIN, BOSS].includes(email) };
  let strikes = createStrikes(deps);
  assert.equal(strikes.sync({ runRows: [run(1)] }).users[0].state, 'ok');
  assert.equal(strikes.sync({ runRows: [run(1), run(2, { codes: ['IMAGE_SAFETY_EXHAUSTED', 'FAL_CONTENT_CHECKER'] })] }).users[0].state, 'near');
  strikes.sync({ runRows: [run(1), run(2), run(3)] });
  assert.equal(strikes.evaluate().users[0].state, 'due');
  assert.equal(strikes.evaluate().users[0].total, 3);
  assert.equal(strikes.isBlocked(ALICE), false, 'automatic blocking defaults off');
  env.STRIKE_AUTO_BLOCK = 'true'; strikes.sync(); assert.equal(strikes.isBlocked(ALICE), false);
  env.STRIKE_AUTO_BLOCK = '1'; strikes.sync(); assert.equal(strikes.isBlocked(ALICE), true);
  assert.equal(strikes.evaluate().users[0].blockedReason, 'strikes');
  strikes.unblock(' ALICE@EXAMPLE.COM ');
  strikes = createStrikes(deps);
  strikes.sync({ runRows: [run(1), run(2), run(3)] });
  assert.equal(strikes.isBlocked(ALICE), false, 'unblocking survives restart and repeated sync');
  strikes.sync({ runRows: [run(4)] }); assert.equal(strikes.isBlocked(ALICE), true, 'one new strike permits automatic blocking');
  strikes.sync({ runRows: [run('admin', { user: ADMIN }), run('local', { user: 'lokal' })] });
  assert.equal(strikes.evaluate().users.find((row) => row.email === ADMIN).count, 1);
  assert.equal(strikes.evaluate().users.find((row) => row.email === 'lokal').blockable, false);
  for (const email of [ADMIN, BOSS]) assert.throws(() => strikes.block(email), { code: 'CANNOT_BLOCK_ADMIN' });
  for (const email of ['lokal', 'no email', '@bad', 'a@@b.ch', null]) assert.throws(() => strikes.block(email), { code: 'INVALID_EMAIL' });
  const file = path.join(dataDir, 'strikes.json');
  const serialized = fs.readFileSync(file, 'utf8');
  assert(!serialized.includes('private') && !serialized.includes('prompt') && !serialized.includes('error'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataDir, 'blocked-users.json')).mode & 0o777, 0o600);
  const blocked = strikes.list();
  blocked[ADMIN] = { blockedAt: isoTime(), reason: 'manual', by: BOSS };
  fs.writeFileSync(path.join(dataDir, 'blocked-users.json'), JSON.stringify(blocked));
  assert.equal(strikes.isBlocked(ADMIN), false, 'even an on-disk admin block has no effect');
  env.STRIKE_LIMIT = 'bad'; env.STRIKE_WINDOW_DAYS = '-1';
  assert.equal(strikes.evaluate().limit, 3); assert.equal(strikes.evaluate().windowDays, 30);
  env.STRIKE_LIMIT = '2'; env.STRIKE_WINDOW_DAYS = '1';
  at += 2 * DAY;
  assert.equal(strikes.evaluate().users.find((row) => row.email === ALICE).count, 0);
  assert.equal(strikes.evaluate().users.find((row) => row.email === ALICE).total, 4);
  assert.equal(strikes.evaluate().users.find((row) => row.email === ALICE).state, 'ok');
  const job = { sessionId: 's', jobId: 'j', user: ALICE, status: 'failed', ts: isoTime(), errorCode: 'FAL_CONTENT_CHECKER', model: 'fal/model' };
  strikes.sync({ jobRows: [job, job] });
  assert.equal(strikes.evaluate().recent[0].id, 'job:s:j');
  assert.equal(strikes.evaluate().users.find((row) => row.email === ALICE).state, 'near');
  strikes.sync({ runRows: [run('nodes', { codes: [], error: 'unrelated', failures: [{ code: 'VIDEO_REAL_PERSON', message: 'sensitive content' }, { code: 'FAL_CONTENT_CHECKER', message: 'refused' }] })] });
  assert.equal(strikes.evaluate().users.find((row) => row.email === ALICE).state, 'due');
  const corrupt = '{broken'; fs.writeFileSync(file, corrupt);
  assert.throws(() => strikes.sync({ runRows: [run(99)] })); assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  let warnings = 0;
  const broken = createStrikes({ ...deps, warn: () => { warnings += 1; } });
  fs.writeFileSync(path.join(dataDir, 'blocked-users.json'), corrupt);
  assert.equal(broken.isBlocked(ALICE), false); assert.equal(broken.isBlocked(ALICE), false); assert.equal(warnings, 1);
  assert.throws(() => broken.unblock(ALICE));
  const retentionDir = path.join(root, 'retention'); fs.mkdirSync(retentionDir);
  const retainedRows = Array.from({ length: 5002 }, (_, i) => ({ id: `run:w:${i}`, ts: isoTime(-i * 1000), user: ALICE, source: 'run', code: 'CONTENT_REFUSED' }));
  retainedRows.push({ id: 'run:old:old', ts: isoTime(-366 * DAY), user: ALICE, source: 'run', code: 'CONTENT_REFUSED' });
  fs.writeFileSync(path.join(retentionDir, 'strikes.json'), JSON.stringify(retainedRows));
  createStrikes({ ...deps, dataDir: retentionDir }).sync();
  const retained = JSON.parse(fs.readFileSync(path.join(retentionDir, 'strikes.json')));
  assert.equal(retained.length, 5000); assert(!retained.some((row) => row.id === 'run:old:old'));
}

function capacity() {
  assert.deepEqual(capacityVerdict({}), { verdict: 'ok', reasons: [] });
  for (const [key, code, ok, watch, upgrade] of [
    ['loadPerCpu15', 'LOAD_HIGH', 0.799, 0.8, 1], ['memAvailablePct', 'MEMORY_LOW', 15, 8, 7.99],
    ['diskFreePct', 'DISK_LOW', 15, 8, 7.99], ['eventLoopLagMs', 'EVENT_LOOP_LAG', 200, 500, 500.01]
  ]) {
    assert.equal(capacityVerdict({ [key]: null }).verdict, 'ok');
    assert.equal(capacityVerdict({ [key]: ok }).verdict, 'ok');
    assert.equal(capacityVerdict({ [key]: watch }).verdict, 'watch');
    const report = capacityVerdict({ [key]: upgrade });
    assert.equal(report.verdict, 'upgrade'); assert.equal(report.reasons[0].code, code);
  }
  assert.equal(capacityVerdict({ online: 14, testedUsers: 14 }).verdict, 'ok');
  assert.equal(capacityVerdict({ online: 15 }).reasons[0].code, 'USERS_ABOVE_TESTED');
  const all = capacityVerdict({ online: 15, loadPerCpu15: 1, memAvailablePct: 2, diskFreePct: 1, eventLoopLagMs: 900 });
  assert.equal(all.reasons.length, 5); assert.equal(all.verdict, 'upgrade');
}

async function monitoring(root) {
  const monitor = createMonitor({ file: path.join(root, 'api-errors.json'), now: () => at });
  function request(email, url = '/api/me') {
    const res = new EventEmitter(); res.statusCode = 200;
    monitor.middleware({ path: url, kubleUser: email, method: 'GET' }, res, () => {});
    res.emit('finish');
  }
  request(ALICE); request(ALICE); request(null); request('lokal'); request('anon'); request(BOSS, '/api/admin/activity');
  assert.equal(monitor.activity().length, 2); assert.equal(monitor.activity().find((row) => row.user === ALICE).requests5m, 2);
  at += 299999; assert.equal(monitor.activity().find((row) => row.user === ALICE).requests5m, 2);
  at += 1; assert.deepEqual(monitor.activity(), []);
  request(ALICE); at += 300001; request(ALICE);
  assert.equal(monitor.activity().find((row) => row.user === ALICE).requests5m, 1, 'a new request excludes earlier expired buckets');
  for (let i = 0; i < 2001; i += 1) request(`p${i}@example.com`);
  assert.equal(monitor.activity().length, 2000); assert(!monitor.activity().some((row) => row.user === 'p0@example.com'));
  const res = new EventEmitter(); res.statusCode = 500;
  monitor.middleware({ path: '/api/admin/activity', kubleUser: BOSS }, res, () => {}); res.emit('finish');
  assert.equal((await monitor.readErrors()).length, 0, 'activity polling never enters the error journal');
  await monitor.flush();
}

async function activity(root) {
  const dataDir = path.join(root, 'history');
  let syncs = 0, resets = 0, enabled = 0, cleared = 0, unref = 0;
  const deps = { dataDir, now: () => at, env: { CAPACITY_TESTED_USERS: 'no' }, isActive: () => true,
    readRuns: async () => [run('running', { status: 'running' }), run('approval', { status: 'awaiting_approval' })],
    readJobs: async () => [
      { sessionId: 's', jobId: 'open', user: ALICE, ts: isoTime(-1000), status: 'pending' },
      { sessionId: 's', jobId: 'old', ts: isoTime(-2 * DAY), status: 'pending' },
      { sessionId: 's', jobId: 'done', ts: isoTime(), status: 'completed' }
    ], readTeams: () => [{ name: 'Team A', members: [{ email: ALICE }] }],
    readCosts: async () => [
      { ts: isoTime(), user: ALICE, type: 'magnific', cost: 0, credits: 10 },
      { ts: isoTime(-2 * 3600000), user: ALICE, type: 'fal', cost: 0.5 },
      { ts: isoTime(-2 * DAY), user: ALICE, type: 'fal', cost: 99 },
      { ts: isoTime(), user: BOSS, type: 'magnific', cost: 0 }
    ], readCreditRates: () => ({ magnific: 0.2 }), readQueue: () => ({ snapshot: () => [{ status: 'queued' }, { status: 'running' }, { status: 'completed' }] }),
    strikes: { sync: () => { syncs += 1; }, evaluate: () => ({ users: [], recent: [] }) },
    monitor: { activity: () => [{ user: ALICE, lastSeen: isoTime(), requests5m: 5 }] },
    osImpl: { loadavg: () => [1, 2, 3], cpus: () => [{}, {}, {}, {}], totalmem: () => 100 * 1048576,
      freemem: () => 10 * 1048576, platform: () => 'linux', uptime: () => 42 },
    readMeminfo: async () => 'MemAvailable: 20480 kB\n', statfs: async () => ({ blocks: 100, bavail: 30, bsize: 1073741824 }),
    memoryUsage: () => ({ rss: 4 * 1048576 }),
    lag: { count: 2, percentile: () => 12000000, reset: () => { resets += 1; }, enable: () => { enabled += 1; }, disable() {} },
    setTimer: (callback, ms) => { assert.equal(ms, 60000); return { unref: () => { unref += 1; } }; }, clearTimer: () => { cleared += 1; }
  };
  const reader = createActivity(deps);
  await reader.sample();
  let report = await reader.snapshot();
  assert.equal(report.runs[1].status, 'waiting_approval'); assert.equal(report.online[0].runsRunning, 2);
  assert.deepEqual(report.online[0].teams, ['Team A']); assert.equal(report.online[0].requests5m, 5);
  assert.equal(report.jobs.length, 1); assert.deepEqual(report.renderQueue, { waiting: 1, running: 1 });
  assert.equal(report.system.memAvailablePct, 20); assert.equal(report.system.memUsedPct, 80);
  assert.equal(report.system.loadPerCpu15, 0.75); assert.equal(report.system.diskFreePct, 30);
  assert.equal(report.system.eventLoopLagMs, 12); assert.equal(report.system.rssMb, 4);
  assert.equal(report.costs.todayUsd, 2.5); assert.equal(report.costs.last24hUsd, 2.5); assert.equal(report.costs.lastHourUsd, 2);
  assert.equal(report.costs.unknownToday, 1); assert.equal(report.capacity.testedUsers, 14);
  assert.equal(report.history.length, 1); assert.equal(report.peaks.d7.online, 1);
  assert.equal(fs.statSync(path.join(dataDir, 'admin-load-history.json')).mode & 0o777, 0o600);
  const first = fs.readFileSync(path.join(dataDir, 'admin-load-history.json'), 'utf8');
  at += 60000; await reader.sample();
  assert.equal(fs.readFileSync(path.join(dataDir, 'admin-load-history.json'), 'utf8'), first, 'writes are throttled');
  at += 240000; await reader.sample();
  const restarted = createActivity(deps);
  assert.equal((await restarted.snapshot()).history.length, 3, 'history survives restart');
  assert(resets >= 3 && syncs >= 3);
  reader.start(); reader.start(); await reader.stop(); assert.equal(enabled, 1); assert.equal(cleared, 1); assert.equal(unref, 1);
  let release;
  const blocked = createActivity({ ...deps, readRuns: () => new Promise((resolve) => { release = resolve; }) });
  const inFlight = blocked.sample(); assert.equal(await blocked.sample(), null, 'samples cannot overlap');
  release([]); await inFlight; await blocked.stop();
  const inactive = createActivity({ ...deps, isActive: () => false }); inactive.start(); assert.equal(await inactive.sample(), null); await inactive.stop();
  const noMetrics = createActivity({ ...deps, readQueue: () => { throw new Error('unavailable'); }, statfs: async () => { throw new Error('unsupported'); }, readMeminfo: async () => { throw new Error('no proc'); } });
  report = await noMetrics.snapshot(); assert.equal(report.system.diskFreePct, null); assert.equal(report.system.memAvailablePct, 10); assert.deepEqual(report.renderQueue, { waiting: null, running: null }); await noMetrics.stop();
  const peaksDir = path.join(root, 'peaks'); fs.mkdirSync(peaksDir);
  const point = (offset, online) => ({ ts: isoTime(offset), online, runsRunning: 1, jobsOpen: 0, loadPerCpu: online / 10, memUsedPct: 50 });
  fs.writeFileSync(path.join(peaksDir, 'admin-load-history.json'), JSON.stringify([
    point(-8 * DAY, 999), point(-2 * DAY, 42), ...Array.from({ length: 400 }, (_, i) => point(-i * 60000, 3)).reverse()
  ]));
  const peaks = createActivity({ ...deps, dataDir: peaksDir });
  const peakReport = await peaks.snapshot();
  assert.equal(peakReport.peaks.h24.online, 3); assert.equal(peakReport.peaks.d7.online, 42);
  assert(peakReport.history.length <= 300); assert(peakReport.history.every((row, index, rows) => index === 0 || row.ts > rows[index - 1].ts));
  await peaks.stop();
  let warned = 0;
  const failedSync = createActivity({ ...deps, strikes: { sync: () => { throw new Error('broken journal'); } }, warn: () => { warned += 1; },
    osImpl: { ...deps.osImpl, uptime: () => { throw new Error('EPERM'); } } });
  assert(await failedSync.sample(), 'a strike failure never interrupts sampling'); assert(warned > 0); await failedSync.stop();
  await restarted.stop();
}

async function routes() {
  const iso = await createIsolatedApp({ env: { ADMIN_EMAILS: ADMIN, SUPERADMIN_EMAILS: BOSS, INTERNAL_EMAIL_DOMAINS: 'example.com' } });
  try {
    await iso.listen();
    const strikes = iso.load('lib/strikes').defaultStore;
    const teams = iso.load('lib/teams');
    const team = teams.createTeam({ name: 'Course' });
    teams.addMembers(team.id, [ALICE]);
    for (const as of [ALICE, 'guest@external.ch', ADMIN, null]) {
      for (const [url, method] of [['/api/admin/activity', 'GET'], ['/api/admin/activity/block', 'POST'], ['/api/admin/activity/unblock', 'POST'], ['/activity.html', 'GET']]) {
        const response = await iso.request(url, { as, method, json: method === 'POST' ? { email: ALICE } : undefined });
        assert.equal(response.status, as === null && url.startsWith('/api/') ? 401 : 404, `${url} as ${as}`);
      }
    }
    // A confirmed guest receives exactly the same invisible feature as a participant or ordinary admin.
    const wfStore = iso.load('lib/nodes/workflows-store').defaultStore;
    const { workflow } = await wfStore.createWorkflow({ name: 'Refused', user: ALICE });
    await wfStore.writeRun(workflow.id, { id: wfStore.newRunId(), user: ALICE, status: 'failed', startedAt: new Date().toISOString(), nodes: {
      a: { status: 'error', code: 'VIDEO_REAL_PERSON', message: 'sensitive content' },
      b: { status: 'error', error: { code: 'FAL_CONTENT_CHECKER', message: 'private provider text' } }
    } });
    const compact = await wfStore.listAllRuns();
    assert(compact[0].codes.includes('VIDEO_REAL_PERSON') && compact[0].codes.includes('FAL_CONTENT_CHECKER'));
    const report = await iso.request('/api/admin/activity', { as: BOSS });
    assert.equal(report.status, 200); assert.equal(report.headers.get('cache-control'), 'no-store');
    for (const key of ['generatedAt', 'capacity', 'online', 'runs', 'jobs', 'renderQueue', 'system', 'costs', 'peaks', 'history', 'strikes']) assert(key in report.body, key);
    assert.equal(report.body.strikes.users[0].count, 1, 'retained runs are synchronised immediately');
    assert(!JSON.stringify(report.body).includes('private provider text'));
    assert.equal((await iso.request('/activity.html', { as: BOSS })).status, 200);
    for (const url of ['/Activity.HTML', '/%61ctivity.html', '//activity.html']) assert.equal(await iso.rawStatus(url, { as: ADMIN }), 404);
    for (const email of ['lokal', 'bad']) assert.equal((await iso.request('/api/admin/activity/block', { method: 'POST', as: BOSS, json: { email } })).body.code, 'INVALID_EMAIL');
    for (const email of [ADMIN, BOSS]) {
      const response = await iso.request('/api/admin/activity/block', { method: 'POST', as: BOSS, json: { email } });
      assert.equal(response.status, 409); assert.equal(response.body.code, 'CANNOT_BLOCK_ADMIN');
    }
    const blocked = await iso.request('/api/admin/activity/block', { method: 'POST', as: BOSS, json: { email: ' ALICE@EXAMPLE.COM ' } });
    assert.equal(blocked.status, 200); assert.equal(blocked.body.user.blocked, true); assert.equal(blocked.body.user.blockedReason, 'manual');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await iso.request('/api/sessions', { method, as: ALICE, json: {} });
      assert.equal(response.status, 403); assert.equal(response.body.code, 'ACCOUNT_BLOCKED');
      assert.deepEqual(Object.keys(response.body.messages).sort(), ['de', 'en', 'es']);
    }
    assert.equal((await iso.request('/api/sessions', { as: ALICE })).status, 200);
    assert.equal((await iso.request('/api/sessions', { as: ALICE, method: 'HEAD' })).status, 200);
    assert.notEqual((await iso.request('/api/sessions', { as: ALICE, method: 'OPTIONS' })).status, 403);
    const keys = createKeyStore({ file: path.join(iso.root, 'data', 'test-keys.json'), viewerFor: () => ({ active: true, identified: true, email: ALICE, kind: 'internal' }), isBlocked: strikes.isBlocked });
    const key = keys.create({ name: 'Test', owner: ALICE, right: 'read' });
    const oauth = keys.create({ name: 'OAuth', owner: ALICE, right: 'read', oauth: { clientId: 'test', clientName: 'Test', resource: 'https://example.com/mcp' } });
    assert.equal(keys.authenticate(key.secret).reason, 'owner_invalid'); assert.equal(keys.get(key.key.id).ownerValid, false);
    assert.equal(keys.authenticateConnection(oauth.key.id, 'https://example.com/mcp').reason, 'owner_invalid');
    const unblocked = await iso.request('/api/admin/activity/unblock', { method: 'POST', as: BOSS, json: { email: ALICE } });
    assert.equal(unblocked.body.user.blocked, false); assert.equal(keys.authenticate(key.secret).ok, true);
    assert.equal(keys.authenticateConnection(oauth.key.id, 'https://example.com/mcp').ok, true);
    assert.equal((await iso.request('/api/admin/activity/unblock', { method: 'POST', as: BOSS, json: { email: 'lokal' } })).status, 400);
    // Check the real jobs reader carries stable codes and models into sync.
    const session = await iso.load('lib/store').createSession();
    await iso.load('lib/store').mutateSession(session.id, (record) => record.jobs.push({ jobId: 'j', createdAt: new Date().toISOString(), status: 'failed', errorCode: 'FAL_CONTENT_CHECKER', model: 'fal/test' }));
    const jobs = await createJobsReader({ projectsDir: path.join(iso.root, 'projects') })();
    assert.equal(jobs[0].errorCode, 'FAL_CONTENT_CHECKER'); assert.equal(jobs[0].model, 'fal/test');
  } finally { await iso.cleanup(); }
  const local = await createIsolatedApp({ active: false, env: { SUPERADMIN_EMAILS: BOSS } });
  try {
    await local.listen();
    for (const [url, method] of [['/activity.html', 'GET'], ['/api/admin/activity', 'GET'], ['/api/admin/activity/block', 'POST'], ['/api/admin/activity/unblock', 'POST']]) assert.equal((await local.request(url, { as: BOSS, method, json: method === 'POST' ? { email: ALICE } : undefined })).status, 404);
    // A local request is never blocked, even with an injected block list.
    let continued = false;
    createBlockGuard({ strikes: { isBlocked: () => true }, isActive: () => false })({ path: '/api/x', method: 'POST' }, {}, () => { continued = true; });
    assert(continued);
  } finally { await local.cleanup(); }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-activity-test-'));
  try { classification(); await journals(root); capacity(); await monitoring(root); await activity(root); await routes(); }
  finally { await fsp.rm(root, { recursive: true, force: true }); }
  console.log('test-admin-activity.js: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
