'use strict';

const budget = require('./budget');

function round(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid credit USD charge');
  return Number(value.toFixed(6));
}

// Both providers freeze the participant's rate and fallback reservation on the job.
function completion(job, actual, rateKey) {
  const credits = actual ?? job.estimateCredits ?? null;
  const participant = Number.isFinite(job[rateKey]) && job[rateKey] > 0;
  const usd = participant ? (credits === null ? job.unknownCostUsd ?? budget.ASYNC_HOLD_USD() : round(credits * job[rateKey])) : 0;
  return { cost: usd, ...(participant ? { usd } : {}), ...(credits === null ? {} : { credits }),
    ...(actual === null ? { billing: credits === null ? 'unknown-price-flat' : 'credit-estimate' } : {}) };
}

module.exports = { round, completion };
