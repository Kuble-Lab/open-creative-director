'use strict';

// A script-free consent page. Texts come from the same DE/EN/ES dictionary as the app.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/i18n.js'), 'utf8'), { window });
const dictionaries = window.I18N;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function language(req) {
  const explicit = req.query?.lang || req.body?.lang || req.language || req.lang;
  if (['de', 'en', 'es'].includes(explicit)) return explicit;
  for (const part of String(req.headers['accept-language'] || '').split(',')) {
    const lang = part.trim().slice(0, 2).toLowerCase();
    if (['de', 'en', 'es'].includes(lang)) return lang;
  }
  return 'de';
}
function translator(lang) {
  return (key, vars = {}) => String(dictionaries[lang]?.[key] || dictionaries.de[key] || key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
function page(lang, content) {
  return `<!doctype html><html lang="${escape(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(translator(lang)('oauth.title'))}</title><style>body{font:16px system-ui,sans-serif;background:#10141d;color:#eef1f8;margin:0;padding:32px 16px}main{max-width:540px;margin:4vh auto;padding:28px;border:1px solid #394458;border-radius:16px;background:#191f2b}h1{font-size:24px}p{line-height:1.55;overflow-wrap:anywhere}label{display:block;margin:16px 0}button,select{font:inherit;padding:12px;border-radius:8px}button{cursor:pointer;background:#dce6ff;color:#15223b;border:0;margin:8px 8px 0 0}.host{font-size:20px;font-weight:700;color:#b9d1ff}small{color:#bec8da}</style><main>${content}</main></html>`;
}
function securityHeaders(res, redirect) {
  const origin = redirect ? new URL(redirect).origin : '';
  res.set({ 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${origin ? ` ${origin}` : ''}; frame-ancestors 'none'; base-uri 'none'`, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
}
function errorPage(req, res, status, key = 'oauth.error') {
  securityHeaders(res);
  const lang = language(req);
  return res.status(status).type('html').send(page(lang, `<h1>${escape(translator(lang)('oauth.title'))}</h1><p>${escape(translator(lang)(key))}</p>`));
}
function consentPage({ req, res, client, params, csrf, email, settings, action, scopes }) {
  securityHeaders(res, params.redirect_uri);
  const lang = params.lang || language(req), t = translator(lang);
  const hidden = Object.entries({ ...params, lang, csrf }).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('');
  scopes = scopes.split(' ');
  const options = (scopes.includes('mcp:read') ? `<option value="read">${escape(t('mcp.right.read'))}</option>` : '') + (scopes.includes('mcp:start') ? `<option value="start" selected>${escape(t('mcp.right.start'))}</option>` : '');
  const body = `<h1>${escape(t('oauth.title'))}</h1><p>${escape(t('oauth.client'))}: <strong>${escape(client.name)}</strong></p><p>${escape(t('oauth.redirectHost'))}<br><span class="host">${escape(new URL(params.redirect_uri).host)}</span></p><p>${escape(t('oauth.person'))}: ${escape(email)}</p><form method="post" action="${escape(action)}">${hidden}<label>${escape(t('mcp.new.right'))}<br><select name="right">${options}</select></label><p>${escape(t('oauth.limits', { run: settings.defaults.maxRunUsd, month: settings.defaults.maxMonthUsd, days: settings.defaults.expiresInDays }))}</p>${settings.role === 'participant' ? `<p>${escape(t('oauth.teamBudget'))}</p>` : ''}<small>${escape(t('oauth.warning'))}</small><p><button name="decision" value="connect">${escape(t('oauth.connect'))}</button><button name="decision" value="cancel">${escape(t('oauth.cancel'))}</button></p></form>`;
  return res.type('html').send(page(lang, body));
}
module.exports = { consentPage, errorPage, securityHeaders, language };
