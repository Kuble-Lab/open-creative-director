'use strict';

// Der gespeicherte Token allein sagt nichts ueber eine lebende Verbindung: der
// Refresh-Token laeuft nach sieben Tagen ab. Vorher meldete /api/chatgpt/status
// weiter «verbunden», und der Fehler fiel erst auf, wenn jemand ein Abo-Modell
// waehlte. Der Endpunkt fragt jetzt aktiv nach.

const assert = require('node:assert/strict');

const { app } = require('../server');
const chatgpt = require('../lib/chatgpt');

function routeHandler(path, method = 'get') {
  const layer = app._router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Route fehlt: ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(req) {
  const handler = routeHandler('/api/chatgpt/status');
  return new Promise((resolve, reject) => {
    const result = { status: 200, body: null };
    const res = {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; resolve(result); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function main() {
  const originalStatus = chatgpt.status;
  const originalEnsure = chatgpt.ensureAccessToken;
  const originalWhoami = process.env.AUTH_WHOAMI_URL;
  const adminReq = { kubleUser: 'admin@example.com', headers: {} };
  // Ohne konfigurierte Anmeldung gilt jeder Aufruf als Admin - hier geht es um den
  // Statusabruf selbst, die Rechtepruefung deckt test-admins.js ab.
  process.env.AUTH_WHOAMI_URL = '';

  try {
    // Fall 1: gespeicherter Token, aber der Refresh scheitert -> der Client raeumt
    // auf, der Endpunkt meldet ehrlich «nicht verbunden».
    let ensureAufrufe = 0;
    let gespeichert = { connected: true, plan: 'pro', expiresAt: Date.now() - 1000, models: ['chatgpt/gpt-5.6-sol'] };
    chatgpt.status = () => gespeichert;
    chatgpt.ensureAccessToken = async () => {
      ensureAufrufe += 1;
      gespeichert = { connected: false, plan: null, expiresAt: null, models: [] };
      throw new Error('Invalid refresh token.');
    };

    const abgelaufen = await invoke(adminReq);
    assert.equal(ensureAufrufe, 1, 'der Status muss die Verbindung wirklich pruefen');
    assert.equal(abgelaufen.body.connected, false, 'eine tote Verbindung darf nicht als verbunden gelten');
    assert.deepEqual(abgelaufen.body.models, [], 'ohne Verbindung keine Abo-Modelle');

    // Fall 2: alles in Ordnung -> Status bleibt verbunden.
    gespeichert = { connected: true, plan: 'pro', expiresAt: Date.now() + 3600000, models: ['chatgpt/gpt-5.6-sol'] };
    chatgpt.ensureAccessToken = async () => 'token';
    const lebendig = await invoke(adminReq);
    assert.equal(lebendig.body.connected, true);
    assert.equal(lebendig.body.plan, 'pro');

    // Fall 3: gar kein Token -> keine unnoetige Nachfrage nach draussen.
    let unerwartet = false;
    gespeichert = { connected: false, plan: null, expiresAt: null, models: [] };
    chatgpt.ensureAccessToken = async () => { unerwartet = true; return 'token'; };
    const ohne = await invoke(adminReq);
    assert.equal(ohne.body.connected, false);
    assert.equal(unerwartet, false, 'ohne gespeicherten Token darf kein Refresh versucht werden');

    console.log('OK: der ChatGPT-Status meldet nur eine wirklich lebende Verbindung');
  } finally {
    chatgpt.status = originalStatus;
    chatgpt.ensureAccessToken = originalEnsure;
    if (originalWhoami === undefined) delete process.env.AUTH_WHOAMI_URL;
    else process.env.AUTH_WHOAMI_URL = originalWhoami;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
