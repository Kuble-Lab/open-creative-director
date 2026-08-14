'use strict';

const assert = require('assert/strict');

const { createWhoamiMiddleware } = require('../lib/whoami');

function runMiddleware(middleware, cookie) {
  const req = { headers: cookie ? { cookie } : {} };
  return new Promise((resolve, reject) => {
    Promise.resolve(middleware(req, {}, () => resolve(req.kubleUser))).catch(reject);
  });
}

async function main() {
  const withoutEnv = createWhoamiMiddleware({ getUrl: () => '' });
  assert.equal(await runMiddleware(withoutEnv, 'session=lokal'), 'lokal');

  let requests = 0;
  let forwardedCookie = '';
  const fetchStub = async (_url, options) => {
    requests += 1;
    forwardedCookie = options.headers.Cookie || '';
    return new Response(JSON.stringify({ logged_in: true, email: 'person@example.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const withEnv = createWhoamiMiddleware({
    getUrl: () => 'http://127.0.0.1:8087/auth/whoami',
    fetchImpl: fetchStub
  });
  assert.equal(await runMiddleware(withEnv, 'session=abc'), 'person@example.com');
  assert.equal(await runMiddleware(withEnv, 'session=abc'), 'person@example.com');
  assert.equal(requests, 1, 'Die zweite Anfrage muss aus dem 10-Sekunden-Cache kommen');
  assert.equal(forwardedCookie, 'session=abc');

  const failing = createWhoamiMiddleware({
    getUrl: () => 'http://127.0.0.1:8087/auth/whoami',
    fetchImpl: async () => {
      throw new Error('Stub-Ausfall');
    }
  });
  assert.equal(await runMiddleware(failing, 'session=def'), 'lokal');
  console.log('Whoami-Middleware: ohne Env, mit Stub, Cookie-Weitergabe, Cache und Fehler-Fallback sind korrekt.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
