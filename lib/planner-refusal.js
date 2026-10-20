'use strict';

// A provider refusal is final, even when it carries partial text or is billed.
function refusalError(value) {
  if (!value) return null;
  if (value.code === 'PLANNER_CONTENT_FILTER') return value;
  const choice = value.choices?.[0];
  let body = value.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  const reasons = [value.code, value.finish_reason, value.finishReason, choice?.finish_reason, choice?.native_finish_reason, value.error?.code, body?.error?.code];
  const detail = [value.message, value.error?.message, body?.error?.message, body?.error?.metadata?.raw].filter(Boolean).join(' ');
  if (!reasons.some((reason) => /^(content_filter|content_policy_violation|safety|refusal)$/i.test(String(reason || ''))) &&
      !choice?.message?.refusal && !/content[_ ]filter|content[_ ]policy[_ ]violation|flagged.*moderation|request.*(?:refused|blocked).*safety/i.test(detail)) return null;
  return Object.assign(new Error('The model declined the request (content filter). Please choose another planner model or adjust the brief.'), {
    code: 'PLANNER_CONTENT_FILTER', model: value.model, usd: value.usd ?? value.usage?.cost ?? null,
    finishReason: 'content_filter', contentFilter: true
  });
}

module.exports = { refusalError };
