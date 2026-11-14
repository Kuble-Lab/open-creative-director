'use strict';

// Offline policy storage and effective limits, including fresh reads and unreadable files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicyStore, DEFAULT_PARTICIPANT, PolicyValidationError } = require('../lib/mcp/policy');
const { createKeyStore, DEFAULTS, LIMITS } = require('../lib/mcp/keys');
const { createWorkflowTools } = require('../lib/mcp/workflow-tools');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-mcp-policy-'));
  try {
    const file = path.join(dir, 'policy.json');
    const policy = createPolicyStore({ file });
    const original = { participant: { ...DEFAULT_PARTICIPANT } };
    assert.deepEqual(policy.get(), original);
    assert.equal(fs.existsSync(file), false, 'missing policy uses defaults without writing');
    policy.get().participant.enabled = false;
    assert.deepEqual(policy.get(), original, 'returned data cannot mutate defaults');
    for (const patch of [{ enabled: 0 }, { maxRunUsd: Infinity }, { maxMonthUsd: NaN }, { defaultRunUsd: '1' }, { maxRunUsd: -1 }, { defaultMonthUsd: -1 }, { keysPerOwner: 1.5 }, { defaultExpiresInDays: 1.1 }, { maxExpiresInDays: 0 }, { extra: true }, { constructor: 1 }]) {
      assert.throws(() => policy.set({ participant: { ...DEFAULT_PARTICIPANT, ...patch } }), PolicyValidationError);
      assert.equal(fs.existsSync(file), false, 'invalid writes leave no file');
    }
    for (const value of [null, [], {}, { participant: null }, { participant: [] }, { participant: { enabled: true } }, { ...original, extra: 1 }]) {
      assert.throws(() => policy.set(value), PolicyValidationError);
    }
    assert.deepEqual(policy.set(original), original);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['policy.json'], 'no temporary file left');
    const unreadable = createPolicyStore({ file, io: { readFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
    assert.throws(() => unreadable.get(), PolicyValidationError);
    const brokenWriter = createPolicyStore({ file, io: { ...fs, renameSync() { throw new Error('disk'); } } });
    assert.throws(() => brokenWriter.set(original), PolicyValidationError);
    assert.deepEqual(policy.get(), original, 'failed atomic write preserves previous policy');
    assert.deepEqual(fs.readdirSync(dir), ['policy.json']);

    const person = { active: true, identified: true, email: 'p@example.com', admin: false, kind: 'internal' };
    const keys = createKeyStore({ file: path.join(dir, 'keys.json'), policy, viewerFor: () => ({ ...person }) });
    const high = keys.create({ name: 'Previously internal', owner: person.email, right: 'start', maxRunUsd: 100, maxMonthUsd: 200 });
    assert.equal(high.key.ownerRole, 'internal');
    assert.deepEqual(keys.settingsFor(person).defaults, DEFAULTS);
    assert.equal(keys.settingsFor(person).limits.keysPerOwner, 25);
    person.kind = 'participant';
    assert.equal(keys.authenticate(high.secret).key.maxRunUsd, 5);
    assert.equal(keys.authenticate(high.secret).key.maxMonthUsd, 25);
    assert.equal(keys.get(high.key.id).maxRunUsd, 100, 'stored limits remain unchanged');
    assert.equal(keys.get(high.key.id).effectiveMaxRunUsd, 5);
    assert.equal(keys.get(high.key.id).ownerRole, 'participant');
    assert.equal(keys.authenticate(high.secret).key.storedMaxRunUsd, 100);
    assert.equal(keys.authenticate(high.secret).key.storedMaxMonthUsd, 200);

    const service = {
      registry: { get: () => ({ category: 'text' }) },
      estimate: async () => ({ workflowId: 'wf-x', name: 'x', rev: 1, valid: true, paid: true, blockers: [], steps: [{ type: 'paid', paid: true, runs: true, usd: 0.5 }], totals: { usd: 0.5, credits: 0, unknownNodes: 0, usdKnown: true, runSteps: 1, cachedSteps: 0 } }),
      start: async () => { throw new Error('must never start'); }
    };
    const accounting = { monthUsage: async () => ({ spentUsd: 0, reservedUsd: 0 }), activeCount: () => 0, serialize: (_id, fn) => fn() };
    const tools = createWorkflowTools({ service, accounting });
    const estimate = tools.find((tool) => tool.name === 'estimate_run');
    const run = tools.find((tool) => tool.name === 'run_workflow');
    const lower = (patch) => policy.set({ participant: { ...DEFAULT_PARTICIPANT, ...patch } });
    lower({ defaultRunUsd: 0.1, maxRunUsd: 0.3 });
    const runAuth = keys.authenticate(high.secret);
    const estimateRun = await estimate.handler({ workflow_id: 'wf-x' }, runAuth);
    assert.equal(estimateRun.agent.max_run_usd, 0.3);
    assert.equal(estimateRun.agent.can_start, false);
    assert.match(estimateRun.agent.problems.join(' '), /limit of \$0\.30 per run/);
    await assert.rejects(run.handler({ workflow_id: 'wf-x', max_usd: 10 }, runAuth), (err) => err.details.codes.includes('OVER_RUN_LIMIT'));
    lower({ defaultMonthUsd: 0.1, maxMonthUsd: 0.3 });
    const monthAuth = keys.authenticate(high.secret);
    assert.equal(monthAuth.key.maxRunUsd, 5);
    await assert.rejects(run.handler({ workflow_id: 'wf-x', max_usd: 10 }, monthAuth), (err) => err.details.codes.includes('OVER_MONTH_LIMIT'));
    // Spent plus reserved amounts count against the current ceiling as well.
    lower({ defaultMonthUsd: 0.1, maxMonthUsd: 1 });
    accounting.monthUsage = async () => ({ spentUsd: 0.3, reservedUsd: 0.3 });
    await assert.rejects(run.handler({ workflow_id: 'wf-x', max_usd: 10 }, keys.authenticate(high.secret)), (err) => err.details.codes.includes('OVER_MONTH_LIMIT'));
    lower({ defaultRunUsd: 0, defaultMonthUsd: 0, maxRunUsd: 0, maxMonthUsd: 0 });
    assert.equal(keys.authenticate(high.secret).key.maxRunUsd, 0, 'zero ceilings stay zero');
    assert.equal(keys.authenticate(high.secret).key.maxMonthUsd, 0);
    lower({ enabled: false });
    assert.equal(keys.authenticate(high.secret).reason, 'owner_invalid');
    assert.throws(() => keys.create({ name: 'disabled', owner: person.email, right: 'read' }), (err) => err.code === 'FORBIDDEN_FOR_ROLE');
    fs.writeFileSync(file, '{broken');
    assert.equal(keys.authenticate(high.secret).reason, 'owner_invalid');
    person.kind = 'internal';
    assert.equal(keys.authenticate(high.secret).ok, true, 'broken participant policy leaves internal keys alone');
    assert.equal(keys.authenticate(high.secret).key.maxRunUsd, 100);
    assert.equal(keys.create({ name: 'internal', owner: person.email, right: 'read' }).key.maxRunUsd, 2);
    person.kind = 'participant';
    const withUnreadable = createKeyStore({ file: keys.file, policy: unreadable, viewerFor: () => person });
    assert.equal(withUnreadable.authenticate(high.secret).reason, 'owner_invalid');
    person.admin = true;
    assert.equal(withUnreadable.authenticate(high.secret).ok, true);
    assert.equal(withUnreadable.get(high.key.id).ownerRole, 'admin');
    assert.equal(withUnreadable.settingsFor(person).limits.maxRunUsd, LIMITS.maxRunUsd);
    person.admin = false;
    person.kind = 'guest';
    assert.equal(keys.authenticate(high.secret).reason, 'owner_invalid');
    assert.equal(keys.get(high.key.id).ownerRole, null);
    const local = createKeyStore({ file: keys.file, policy: unreadable, env: {} });
    assert.equal(local.authenticate(high.secret).key.ownerRole, 'local');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test-mcp-policy.js: ok');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
