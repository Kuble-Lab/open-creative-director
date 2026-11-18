'use strict';

// What one workflow has cost so far, over all its runs. The runs of a workflow book into the cost journal (lib/costs.js)
// under its backing session, and the journal keeps every line: run records and result histories are pruned, the journal is
// not. So the total here still counts runs whose records are gone, and work that booked late (a provider job that the
// poller settled after the run ended). Questions to the assistant of the workflow book under the same session and count too.

const MAX_MODELS = 12;
const round = (value) => Math.round(value * 1e6) / 1e6;

function groupRows(map, limit = Infinity) {
  return [...map.values()]
    .map((row) => ({ ...row, usd: round(row.usd) }))
    .sort((a, b) => b.usd - a.usd || b.count - a.count || String(a.model || a.type).localeCompare(String(b.model || b.type)))
    .slice(0, limit);
}

// entries: lines of the cost journal (already normalised by readCosts); sessionId: the backing session of the workflow.
// → { totalUsd, credits, count, firstAt, lastAt, byType: [{ type, usd, count }], byModel: [{ model, type, usd, count }] }
function summariseWorkflowCosts(entries, sessionId) {
  const types = new Map();
  const models = new Map();
  let totalUsd = 0;
  let credits = 0;
  let count = 0;
  let firstAt = null;
  let lastAt = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!sessionId || !entry || entry.sessionId !== sessionId) continue;
    const usd = Number(entry.cost);
    if (!Number.isFinite(usd) || usd < 0) continue;
    totalUsd += usd;
    count += 1;
    if (Number.isFinite(entry.credits) && entry.credits > 0) credits += entry.credits;
    const ts = typeof entry.ts === 'string' ? entry.ts : '';
    if (ts && (!firstAt || ts < firstAt)) firstAt = ts;
    if (ts && (!lastAt || ts > lastAt)) lastAt = ts;
    const type = String(entry.type || '');
    const typeRow = types.get(type) || { type, usd: 0, count: 0 };
    typeRow.usd += usd;
    typeRow.count += 1;
    types.set(type, typeRow);
    const model = String(entry.model || '');
    const modelKey = `${type}\n${model}`;
    const modelRow = models.get(modelKey) || { model, type, usd: 0, count: 0 };
    modelRow.usd += usd;
    modelRow.count += 1;
    models.set(modelKey, modelRow);
  }
  return {
    totalUsd: round(totalUsd),
    credits: round(credits),
    count,
    firstAt,
    lastAt,
    byType: groupRows(types),
    byModel: groupRows(models, MAX_MODELS)
  };
}

module.exports = { summariseWorkflowCosts, MAX_MODELS };
