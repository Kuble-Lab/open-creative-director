'use strict';

const { round, completion: completeCredits } = require('./credit-billing');

// Actual charges only: estimates, balances and unrelated numeric prices are not usage.
function reportedCredits(info, depth = 0) {
  if (!info || typeof info !== 'object' || depth > 10) return null;
  for (const key of ['credits', 'credits_used', 'credits_consumed', 'cost_credits', 'total_credits', 'credit_cost']) {
    const value = info[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  for (const [key, value] of Object.entries(info)) {
    if (/balance|account|remaining|available|estimat|arguments|parameters|inputs/i.test(key)) continue;
    const credits = reportedCredits(value, depth + 1);
    if (credits !== null) return credits;
  }
  return null;
}

function estimate(credits) {
  const rate = require('./settings').getPreference('magnificUsdPerCredit');
  return { rate, credits, estimateUsd: credits === null ? null : round(credits * rate) };
}

function completion(job, info) {
  return completeCredits(job, reportedCredits(info) ?? job.chargedCredits ?? null, 'magnificUsdPerCredit');
}

module.exports = { estimate, reportedCredits, completion };
