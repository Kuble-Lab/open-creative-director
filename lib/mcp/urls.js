'use strict';

// Public addresses include the reverse proxy path prefix.
// The address agents are given: the public base URL of the app when it is set, else derived from the request.
function publicBase(req, env = process.env) {
  const configured = String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const headers = req.headers || {};
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol === 'https' ? 'https' : 'http';
  const trustProxy = /^(1|true|yes)$/i.test(String(env.TRUST_PROXY_HOST || '').trim());
  const host = String((trustProxy && headers['x-forwarded-host']) || headers.host || '').split(',')[0].trim();
  return `${protocol}://${host}`;
}

const endpointUrl = (req, env) => `${publicBase(req, env)}/mcp`;
module.exports = { publicBase, endpointUrl };
