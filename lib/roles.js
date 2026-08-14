'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PATHS } = require('./config');
const store = require('./store');

const ROLES_FILE = path.join(PATHS.root, 'data', 'roles.json');
const MAX_NAME_LENGTH = 60;
const MAX_EMOJI_LENGTH = 2;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_PROMPT_LENGTH = 20000;
const MAX_BRIEF_LENGTH = 2000;

function characterLength(value) {
  return [...String(value)].length;
}

function validateText(value, field, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} muss ein String sein`);
  const clean = value.trim();
  if (required && !clean) throw new Error(`${field} darf nicht leer sein`);
  if (characterLength(clean) > maxLength) {
    throw new Error(`${field} darf maximal ${maxLength} Zeichen lang sein`);
  }
  return clean;
}

function normaliseRoleInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Rolle muss ein Objekt sein');
  }
  return {
    name: validateText(input.name, 'Name', MAX_NAME_LENGTH, { required: true }),
    emoji: validateText(input.emoji === undefined ? '' : input.emoji, 'Emoji', MAX_EMOJI_LENGTH),
    description: validateText(input.description === undefined ? '' : input.description, 'Beschreibung', MAX_DESCRIPTION_LENGTH),
    brief: validateText(input.brief === undefined ? '' : input.brief, 'Aufgabenbeschreibung', MAX_BRIEF_LENGTH),
    prompt: validateText(input.prompt, 'Prompt', MAX_PROMPT_LENGTH, { required: true })
  };
}

function slugify(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'rolle';
}

async function readRoles() {
  try {
    const parsed = JSON.parse(await fsp.readFile(ROLES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeRoles(roles) {
  await fsp.mkdir(path.dirname(ROLES_FILE), { recursive: true });
  const tmp = `${ROLES_FILE}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(roles, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, ROLES_FILE);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function listRoles() {
  const roles = await readRoles();
  return roles
    .filter((role) => role && store.isValidId(role.id))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'de-CH'));
}

async function getRole(id) {
  if (!store.isValidId(id)) return null;
  const roles = await readRoles();
  return roles.find((role) => role?.id === id) || null;
}

async function createRole(input) {
  const clean = normaliseRoleInput(input);
  return store.withLock('global-roles', async () => {
    const current = await readRoles();
    let id;
    do {
      id = `${slugify(clean.name)}-${crypto.randomBytes(3).toString('hex')}`;
    } while (current.some((role) => role?.id === id));
    const role = { id, ...clean, createdAt: new Date().toISOString() };
    current.push(role);
    await writeRoles(current);
    return role;
  });
}

async function updateRole(id, input) {
  if (!store.isValidId(id)) throw new Error('Ungueltige Rollen-ID');
  const clean = normaliseRoleInput(input);
  return store.withLock('global-roles', async () => {
    const current = await readRoles();
    const index = current.findIndex((role) => role?.id === id);
    if (index < 0) return null;
    current[index] = { ...current[index], ...clean, id };
    await writeRoles(current);
    return current[index];
  });
}

async function deleteRole(id) {
  if (!store.isValidId(id)) throw new Error('Ungueltige Rollen-ID');
  return store.withLock('global-roles', async () => {
    const current = await readRoles();
    const next = current.filter((role) => role?.id !== id);
    if (next.length === current.length) return false;
    await writeRoles(next);
    return true;
  });
}

module.exports = {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  normaliseRoleInput
};
