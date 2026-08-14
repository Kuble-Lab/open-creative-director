'use strict';

const fs = require('fs');
const path = require('path');

const { PATHS } = require('./config');

const ADMINS_FILE = path.join(PATHS.root, 'data', 'admins.json');
const MAX_ADMINS = 50;

class AdminValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminValidationError';
  }
}

class AdminNotFoundError extends Error {
  constructor(email) {
    super(`Admin ${email} wurde nicht gefunden.`);
    this.name = 'AdminNotFoundError';
  }
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') throw new AdminValidationError('Die E-Mail-Adresse muss ein String sein.');
  const email = raw.trim().toLowerCase();
  const at = email.indexOf('@');
  const dot = email.lastIndexOf('.');
  if (!email || at <= 0 || at !== email.lastIndexOf('@') || dot <= at + 1 || dot >= email.length - 1 || /\s/.test(email)) {
    throw new AdminValidationError('Bitte eine gueltige E-Mail-Adresse eingeben.');
  }
  if ([...email].length > 254) throw new AdminValidationError('Die E-Mail-Adresse darf maximal 254 Zeichen lang sein.');
  return email;
}

function envAdminEmails(env = process.env) {
  const raw = String(env.ADMIN_EMAILS || '');
  const result = [];
  for (const entry of raw.split(',')) {
    try {
      const email = normalizeEmail(entry);
      if (!result.includes(email)) result.push(email);
    } catch (_) {
      /* Ungueltige .env-Eintraege gewaehrleisten keinen Zugriff. */
    }
  }
  return result;
}

function createAdminsStore({ file = ADMINS_FILE, fsImpl = fs } = {}) {
  function listStoredAdmins() {
    let parsed = [];
    try {
      parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error('data/admins.json ist ungueltig oder konnte nicht gelesen werden.');
    }
    if (!Array.isArray(parsed)) throw new Error('data/admins.json muss ein JSON-Array enthalten.');
    if (parsed.length > MAX_ADMINS) throw new Error(`data/admins.json darf maximal ${MAX_ADMINS} Eintraege enthalten.`);
    const normalized = parsed.map(normalizeEmail);
    if (new Set(normalized).size !== normalized.length) throw new Error('data/admins.json enthaelt doppelte E-Mail-Adressen.');
    return normalized;
  }

  function writeStoredAdmins(admins) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    fsImpl.writeFileSync(temporaryFile, `${JSON.stringify(admins, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fsImpl.chmodSync(temporaryFile, 0o600);
    fsImpl.renameSync(temporaryFile, file);
    fsImpl.chmodSync(file, 0o600);
  }

  function listAdmins(env = process.env) {
    const envEmails = envAdminEmails(env);
    const stored = listStoredAdmins();
    return [
      ...envEmails.map((email) => ({ email, source: 'env' })),
      ...stored.filter((email) => !envEmails.includes(email)).map((email) => ({ email, source: 'settings' }))
    ];
  }

  function addAdmin(rawEmail) {
    const email = normalizeEmail(rawEmail);
    const stored = listStoredAdmins();
    if (envAdminEmails().includes(email) || stored.includes(email)) {
      throw new AdminValidationError('Diese E-Mail-Adresse ist bereits als Admin eingetragen.');
    }
    if (stored.length >= MAX_ADMINS) throw new AdminValidationError(`Es sind maximal ${MAX_ADMINS} Admins erlaubt.`);
    writeStoredAdmins([...stored, email]);
    return email;
  }

  function deleteAdmin(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (envAdminEmails().includes(email)) {
      throw new AdminValidationError('Aus .env gesetzt — nicht entfernbar.');
    }
    const stored = listStoredAdmins();
    if (!stored.includes(email)) throw new AdminNotFoundError(email);
    writeStoredAdmins(stored.filter((entry) => entry !== email));
    return email;
  }

  return { listStoredAdmins, listAdmins, addAdmin, deleteAdmin };
}

const store = createAdminsStore();

module.exports = {
  ADMINS_FILE,
  MAX_ADMINS,
  AdminValidationError,
  AdminNotFoundError,
  normalizeEmail,
  envAdminEmails,
  createAdminsStore,
  listStoredAdmins: store.listStoredAdmins,
  listAdmins: store.listAdmins,
  addAdmin: store.addAdmin,
  deleteAdmin: store.deleteAdmin
};
