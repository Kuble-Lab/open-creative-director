'use strict';

// Team list: the people a chat or workflow can be shared with. It is NOT an access list (access stays with
// the external login). Sources:
//   - admins (ADMIN_EMAILS, stored admins, SUPERADMIN_EMAILS)
//   - people an admin added in the settings (data/users.json, a JSON array of addresses)
//   - people seen once: the first identified request of a person records them automatically with
//     "first seen" / "last seen" (data/team-seen.json). The external login may admit a whole domain,
//     so nobody has to be typed in by hand.
// An admin can remove an entry. A removed person is not recorded again automatically (the removal is
// remembered) until an admin adds them back.

const fs = require('fs');
const path = require('path');

const access = require('./access');
const admins = require('./admins');
const emailList = require('../public/email-list');
const { PATHS } = require('./config');

const USERS_FILE = path.join(PATHS.root, 'data', 'users.json');
const SEEN_FILE = path.join(PATHS.root, 'data', 'team-seen.json');
const MAX_USERS = 250;
const MAX_SEEN = 2000;
const TOUCH_INTERVAL_MS = 60 * 1000;
const MAX_BULK = 500;

class UserValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserValidationError';
  }
}

class UserNotFoundError extends Error {
  constructor(email) {
    super(`User ${email} wurde nicht gefunden.`);
    this.name = 'UserNotFoundError';
  }
}

function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function createUsersStore({ usersFile = USERS_FILE, seenFile = SEEN_FILE, now = Date.now, env = process.env } = {}) {
  let seenCache = null;
  const lastTouch = new Map();

  /* ----- users maintained in the settings ----- */

  function readUsers() {
    let parsed = [];
    try {
      parsed = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error('data/users.json ist ungueltig oder konnte nicht gelesen werden.');
    }
    if (!Array.isArray(parsed)) throw new Error('data/users.json muss ein JSON-Array enthalten.');
    const emails = parsed.map(admins.normalizeEmail);
    if (emails.length > MAX_USERS) throw new Error(`Es sind maximal ${MAX_USERS} User erlaubt.`);
    return [...new Set(emails)];
  }

  /* ----- people seen once ----- */

  function loadSeen() {
    if (seenCache) return seenCache;
    const map = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const email = access.normalizeEmail(key);
          if (!email || !value || typeof value !== 'object') continue;
          map.set(email, {
            firstSeen: typeof value.firstSeen === 'string' ? value.firstSeen : null,
            lastSeen: typeof value.lastSeen === 'string' ? value.lastSeen : null,
            removed: value.removed === true
          });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[users] data/team-seen.json konnte nicht gelesen werden:', err.message);
    }
    seenCache = map;
    return map;
  }

  function persistSeen() {
    if (!seenCache) return;
    const entries = [...seenCache.entries()];
    // Keep the most recently seen people if the file ever grows past the limit.
    entries.sort((a, b) => String(b[1].lastSeen || '').localeCompare(String(a[1].lastSeen || '')));
    const object = {};
    for (const [email, value] of entries.slice(0, MAX_SEEN)) object[email] = value;
    writeJsonSync(seenFile, object);
  }

  // Called for every identified request. Writes on the first sight and afterwards at most once per interval.
  function touch(rawEmail) {
    const email = access.normalizeEmail(rawEmail);
    if (!email) return false;
    const seen = loadSeen();
    const current = now();
    const known = seen.get(email);
    if (known?.removed) return false;
    if (known && current - (lastTouch.get(email) || 0) < TOUCH_INTERVAL_MS) return false;
    const stamp = new Date(current).toISOString();
    seen.set(email, { firstSeen: known?.firstSeen || stamp, lastSeen: stamp, removed: false });
    lastTouch.set(email, current);
    try {
      persistSeen();
    } catch (err) {
      console.warn('[users] Team-Erfassung konnte nicht gespeichert werden:', err.message);
    }
    return !known;
  }

  /* ----- the team ----- */

  function adminEmails() {
    const result = new Set(access.superadminEmails(env));
    for (const email of admins.envAdminEmails(env)) result.add(email);
    try {
      for (const email of admins.listStoredAdmins()) result.add(email);
    } catch (_) {
      /* an unreadable admins file must not break the team list */
    }
    return result;
  }

  // Every person with their sources and timestamps, sorted by address. Removed people are left out.
  function listMembers() {
    const adminSet = adminEmails();
    const superadminSet = new Set(access.superadminEmails(env));
    const seen = loadSeen();
    const settingsUsers = new Set(readUsers());
    const members = new Map();
    const ensure = (email) => {
      if (!members.has(email)) members.set(email, { email, role: 'user', sources: [], firstSeen: null, lastSeen: null });
      return members.get(email);
    };
    for (const email of adminSet) {
      const member = ensure(email);
      member.role = 'admin';
      member.sources.push(superadminSet.has(email) ? 'superadmin' : 'admin');
    }
    for (const email of settingsUsers) ensure(email).sources.push('settings');
    for (const [email, value] of seen) {
      if (value.removed) continue;
      const member = ensure(email);
      member.sources.push('seen');
      member.firstSeen = value.firstSeen;
      member.lastSeen = value.lastSeen;
    }
    return [...members.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  function isMember(rawEmail) {
    const email = access.normalizeEmail(rawEmail);
    if (!email) return false;
    return listMembers().some((member) => member.email === email);
  }

  function addUser(rawEmail) {
    const email = admins.normalizeEmail(rawEmail);
    if (adminEmails().has(email)) throw new UserValidationError('Diese E-Mail-Adresse ist bereits Admin.');
    const users = readUsers();
    const seen = loadSeen();
    const known = seen.get(email);
    if (users.includes(email) || (known && !known.removed)) {
      throw new UserValidationError('Diese E-Mail-Adresse ist bereits im Team.');
    }
    if (users.length >= MAX_USERS) throw new UserValidationError(`Es sind maximal ${MAX_USERS} User erlaubt.`);
    if (known?.removed) {
      seen.set(email, { ...known, removed: false });
      persistSeen();
    }
    writeJsonSync(usersFile, [...users, email]);
    return email;
  }

  // Several addresses at once (pasted text or a list, read with the shared paste parser). Addresses that are already
  // admins or on the list are reported, not an error. Nothing is written if the list would not fit.
  function addUsers(entries) {
    const list = Array.isArray(entries) ? entries : typeof entries === 'string' ? [entries] : null;
    if (!list || list.some((entry) => typeof entry !== 'string')) throw new UserValidationError('emails muss eine Liste von Adressen (Text) sein.');
    const parsed = emailList.parse(list.join('\n'));
    if (parsed.emails.length + parsed.invalid.length > MAX_BULK) {
      throw new UserValidationError(`Es können höchstens ${MAX_BULK} Adressen auf einmal hinzugefügt werden.`);
    }
    if (!parsed.emails.length && !parsed.invalid.length) throw new UserValidationError('Keine E-Mail-Adresse gefunden.');
    const adminSet = adminEmails();
    const users = readUsers();
    const seen = loadSeen();
    const added = [];
    const already = [];
    for (const email of parsed.emails) {
      const known = seen.get(email);
      if (adminSet.has(email) || users.includes(email) || added.includes(email) || (known && !known.removed)) already.push(email);
      else added.push(email);
    }
    if (users.length + added.length > MAX_USERS) throw new UserValidationError(`Es sind maximal ${MAX_USERS} User erlaubt.`);
    if (added.length) {
      let restored = false;
      for (const email of added) {
        const known = seen.get(email);
        if (known?.removed) {
          seen.set(email, { ...known, removed: false });
          restored = true;
        }
      }
      if (restored) persistSeen();
      writeJsonSync(usersFile, [...users, ...added]);
    }
    return { added, already, invalid: parsed.invalid, duplicates: parsed.duplicates };
  }

  function deleteUser(rawEmail) {
    const email = admins.normalizeEmail(rawEmail);
    if (adminEmails().has(email)) {
      throw new UserValidationError('Admins werden in der Admin-Verwaltung entfernt.');
    }
    const users = readUsers();
    const seen = loadSeen();
    const known = seen.get(email);
    const inSettings = users.includes(email);
    const inSeen = Boolean(known && !known.removed);
    if (!inSettings && !inSeen) throw new UserNotFoundError(email);
    if (inSettings) writeJsonSync(usersFile, users.filter((entry) => entry !== email));
    if (inSeen) {
      seen.set(email, { ...known, removed: true });
      persistSeen();
    }
    return email;
  }

  // Test hook: forget the in-memory state so the files are read again.
  function reset() {
    seenCache = null;
    lastTouch.clear();
  }

  return { readUsers, listMembers, isMember, addUser, addUsers, deleteUser, touch, reset, adminEmails };
}

const defaultStore = createUsersStore();

module.exports = {
  USERS_FILE,
  SEEN_FILE,
  MAX_USERS,
  MAX_SEEN,
  MAX_BULK,
  TOUCH_INTERVAL_MS,
  UserValidationError,
  UserNotFoundError,
  createUsersStore,
  listMembers: defaultStore.listMembers,
  isMember: defaultStore.isMember,
  addUser: defaultStore.addUser,
  addUsers: defaultStore.addUsers,
  deleteUser: defaultStore.deleteUser,
  touch: defaultStore.touch
};
