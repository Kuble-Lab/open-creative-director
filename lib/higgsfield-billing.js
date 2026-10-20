'use strict';

// USD accounting belongs only to participants. Jobs freeze their rate and estimate at submission.
const settings = require('./settings');
const budget = require('./budget');
const round = (value) => {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid Higgsfield USD charge');
  return Number(value.toFixed(6));
};

async function estimate(args = {}) {
  const catalog = require('./nodes/higgsfield-catalog');
  let model = null;
  if (args.model) {
    try { model = await catalog.getModel(args.model); } catch (_) { /* unknown price */ }
  }
  const credits = model ? catalog.creditsFor(model, { duration: args.duration ?? args.extra_params?.duration }) : null;
  const rate = settings.getPreference('higgsfieldUsdPerCredit');
  return { rate, credits, estimateUsd: credits === null ? null : round(credits * rate) };
}

// Only explicit credit fields count as a reported charge; never mistake a balance or a USD price for credits.
function reportedCredits(info) {
  for (const value of [info?.credits, info?.credits_used, info?.credits_consumed, info?.cost?.credits]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  if (typeof info?.text === 'string') {
    try {
      const parsed = require('./tools/higgsfield').parseJsonLoose(info.text);
      for (const value of [parsed, parsed?.job, parsed?.result, parsed?.data, parsed?.generation, parsed?.raw_data]) {
        const credits = reportedCredits(value);
        if (credits !== null) return credits;
      }
    } catch (_) { /* text responses may not include a charge */ }
  }
  return null;
}

function completion(job, info) {
  const actual = reportedCredits(info) ?? job.chargedCredits ?? null;
  const credits = actual ?? job.estimateCredits ?? null;
  const participant = Number.isFinite(job.higgsfieldUsdPerCredit) && job.higgsfieldUsdPerCredit > 0;
  const usd = participant ? (credits === null ? job.unknownCostUsd ?? budget.ASYNC_HOLD_USD() : round(credits * job.higgsfieldUsdPerCredit)) : 0;
  return { cost: usd, ...(participant ? { usd } : {}), ...(credits === null ? {} : { credits }),
    ...(actual === null ? { billing: credits === null ? 'unknown-price-flat' : 'credit-estimate' } : {}) };
}

module.exports = { estimate, reportedCredits, completion };
