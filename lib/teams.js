'use strict';

// Teams for trainings (user management, WP15). An admin creates a team, pastes the participants' addresses and
// sets a USD budget per person. Membership of an active (not archived) team makes a person a "participant":
// access to the app through the team, a budget, and a restricted view (see lib/access.js and lib/budget.js).
//
// Stored in data/teams.json (chmod 600, replaced atomically):
//   { version: 1, teams: [{ id, name, description, budgetUsd, createdAt, createdBy, archived,
//                           members: [{ email, addedAt, budgetStart, budgetOverrideUsd|null }] }],
//     known: [address] }
//   known                every address that was ever in a team (also removed people and deleted teams); only grows.
//                        lib/access.js uses it to keep former participants out of the "internal" group when
//                        INTERNAL_EMAIL_DOMAINS is empty.
//   budgetUsd            USD per person for the whole training (>= 0)
//   budgetOverrideUsd    replaces budgetUsd for one member (null = the team amount)
//   budgetStart          spending counts from here on; "reset" sets it to now
//
// The file is read lazily and cached; every change made through this module invalidates the cache and notifies
// the listeners (the allowlist sync). A file changed by hand is picked up within CHECK_INTERVAL_MS.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const access = require('./access');
const emailList = require('../public/email-list');
const { PATHS } = require('./config');

const TEAMS_FILE = path.join(PATHS.root, 'data', 'teams.json');
const LIMITS = Object.freeze({
  maxTeams: 200,
  maxMembersPerTeam: 2000,
  maxBulk: 500,
  maxBudgetUsd: 10000,
  maxNameLength: 80,
  maxDescriptionLength: 400
});
const CHECK_INTERVAL_MS = 2000;
const MAX_KNOWN = 100000;

class TeamValidationError extends Error {
  constructor(message, code = 'INVALID_TEAM') {
    super(message);
    this.name = 'TeamValidationError';
    this.code = code;
  }
}

class TeamNotFoundError extends Error {
  constructor(id) {
    super(`Team ${id} wurde nicht gefunden.`);
    this.name = 'TeamNotFoundError';
    this.code = 'TEAM_NOT_FOUND';
  }
}

class MemberNotFoundError extends Error {
  constructor(email) {
    super(`${email} ist nicht in diesem Team.`);
    this.name = 'MemberNotFoundError';
    this.code = 'MEMBER_NOT_FOUND';
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// USD amounts are kept to whole cents.
function cleanAmount(value, label) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > LIMITS.maxBudgetUsd) {
    throw new TeamValidationError(`${label} muss eine Zahl zwischen 0 und ${LIMITS.maxBudgetUsd} sein.`, 'INVALID_BUDGET');
  }
  return Math.round(number * 100) / 100;
}

function cleanText(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TeamValidationError(`${label} darf nicht leer sein.`, 'INVALID_TEAM');
    return '';
  }
  if (typeof value !== 'string') throw new TeamValidationError(`${label} muss ein Text sein.`, 'INVALID_TEAM');
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !text) throw new TeamValidationError(`${label} darf nicht leer sein.`, 'INVALID_TEAM');
  if ([...text].length > max) throw new TeamValidationError(`${label} darf maximal ${max} Zeichen lang sein.`, 'INVALID_TEAM');
  return text;
}

function isoOr(value, fallback) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function readAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, LIMITS.maxBudgetUsd) : null;
}

// Normalises a team read from disk; anything unusable is dropped or defaulted (hand-edited files stay readable).
function sanitiseTeam(raw, fallbackTime) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) return null;
  const members = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw.members) ? raw.members : []) {
    const email = access.normalizeEmail(isPlainObject(entry) ? entry.email : typeof entry === 'string' ? entry : null);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const addedAt = isoOr(entry.addedAt, fallbackTime);
    members.push({
      email,
      addedAt,
      budgetStart: isoOr(entry.budgetStart, addedAt),
      budgetOverrideUsd: readAmount(entry.budgetOverrideUsd)
    });
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, LIMITS.maxNameLength) : raw.id,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, LIMITS.maxDescriptionLength) : '',
    budgetUsd: readAmount(raw.budgetUsd) ?? 0,
    createdAt: isoOr(raw.createdAt, fallbackTime),
    createdBy: access.normalizeEmail(raw.createdBy),
    archived: raw.archived === true,
    members
  };
}

function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function createTeamsStore({ file = TEAMS_FILE, now = Date.now, checkIntervalMs = CHECK_INTERVAL_MS } = {}) {
  let cache = null; // { teams, byId, byEmail, mtimeMs, size, checkedAt }
  let lastGood = null;
  let readProblem = null;
  const listeners = new Set();

  function index(teams) {
    const byId = new Map();
    const byEmail = new Map(); // email -> memberships of active teams
    const history = new Map(); // email -> memberships of every team, archived ones included (WP22 team groups)
    for (const team of teams) {
      byId.set(team.id, team);
      for (const member of team.members) {
        if (!history.has(member.email)) history.set(member.email, []);
        history.get(member.email).push({ teamId: team.id, addedAt: member.addedAt });
      }
      if (team.archived) continue;
      for (const member of team.members) {
        if (!byEmail.has(member.email)) byEmail.set(member.email, []);
        byEmail.get(member.email).push({
          teamId: team.id,
          name: team.name,
          budgetUsd: team.budgetUsd,
          budgetOverrideUsd: member.budgetOverrideUsd,
          budgetStart: member.budgetStart,
          addedAt: member.addedAt
        });
      }
    }
    for (const list of history.values()) {
      list.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.teamId.localeCompare(b.teamId));
    }
    return { byId, byEmail, history };
  }

  // known: every address that was ever in a team (the stored list plus everybody in the teams now).
  function build(teams, stat, storedKnown = []) {
    const known = new Set(storedKnown);
    for (const team of teams) for (const member of team.members) known.add(member.email);
    return { teams, ...index(teams), known, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0, checkedAt: now() };
  }

  function load() {
    if (cache && now() - cache.checkedAt < checkIntervalMs) return cache;
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') readProblem = err.message;
    }
    if (!stat) {
      // No file (yet): no teams. A file that disappears after it was read counts as "no teams" as well.
      cache = build([], null);
      return cache;
    }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      cache.checkedAt = now();
      return cache;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.teams) ? parsed.teams : null;
      if (!list) throw new Error('data/teams.json enthält keine Team-Liste.');
      const stamp = new Date(now()).toISOString();
      const teams = list.map((raw) => sanitiseTeam(raw, stamp)).filter(Boolean).slice(0, LIMITS.maxTeams);
      const storedKnown = (!Array.isArray(parsed) && Array.isArray(parsed.known) ? parsed.known : [])
        .map((entry) => access.normalizeEmail(entry))
        .filter(Boolean)
        .slice(0, MAX_KNOWN);
      cache = build(teams, stat, storedKnown);
      lastGood = cache;
      readProblem = null;
    } catch (err) {
      readProblem = err.message;
      console.warn('[teams] data/teams.json konnte nicht gelesen werden:', err.message);
      // Keep answering with the last good state rather than turning participants into somebody else.
      cache = lastGood ? { ...lastGood, checkedAt: now() } : build([], stat);
    }
    return cache;
  }

  function invalidate() {
    cache = null;
  }

  // A mutation refuses to run on a file it could not read: writing would destroy what is in there.
  function requireReadable() {
    load();
    if (readProblem) throw new Error(`data/teams.json ist ungültig und wird nicht überschrieben: ${readProblem}`);
  }

  function persist(teams) {
    const known = new Set(load().known);
    for (const team of teams) for (const member of team.members) known.add(member.email);
    writeJsonSync(file, { version: 1, teams, known: [...known].sort().slice(0, MAX_KNOWN) });
    lastGood = null;
    invalidate();
    load();
    lastGood = cache;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        console.warn('[teams] Listener fehlgeschlagen:', err.message);
      }
    }
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const mutable = () => {
    requireReadable();
    return clone(load().teams);
  };
  const stamp = () => new Date(now()).toISOString();

  /* ----- reading ----- */

  function listTeams({ includeArchived = true } = {}) {
    return clone(load().teams.filter((team) => includeArchived || !team.archived));
  }

  function getTeam(id) {
    const team = load().byId.get(String(id));
    if (!team) throw new TeamNotFoundError(id);
    return clone(team);
  }

  function hasTeam(id) {
    return load().byId.has(String(id));
  }

  // Memberships of active teams; a person in an archived team only is not a participant.
  function membershipsOf(rawEmail) {
    const email = access.normalizeEmail(rawEmail);
    if (!email) return [];
    return (load().byEmail.get(email) || []).map((entry) => ({ ...entry }));
  }

  // Every membership of the address, archived teams included, oldest first. Chats and workflows without a stored team
  // are assigned through it (lib/team-groups.js). Removed people and deleted teams are gone from it.
  function membershipHistoryOf(rawEmail) {
    const email = access.normalizeEmail(rawEmail);
    if (!email) return [];
    return (load().history.get(email) || []).map((entry) => ({ ...entry }));
  }

  // Name, state and size of a team, archived or not (null when it does not exist).
  function teamSummary(id) {
    const team = load().byId.get(String(id));
    return team ? { id: team.id, name: team.name, archived: team.archived, memberCount: team.members.length } : null;
  }

  function activeTeamIdsOf(rawEmail) {
    return membershipsOf(rawEmail).map((entry) => entry.teamId);
  }

  // Ids and names of the active teams (for the sharing dialog and the sharing badges).
  function activeTeams() {
    return load().teams.filter((team) => !team.archived).map((team) => ({ id: team.id, name: team.name, memberCount: team.members.length }));
  }

  function teamName(id) {
    return load().byId.get(String(id))?.name || null;
  }

  function isActiveTeam(id) {
    const team = load().byId.get(String(id));
    return Boolean(team && !team.archived);
  }

  // Everybody in an active team (for the allowlist sync and the people picker).
  function activeMemberEmails() {
    return [...load().byEmail.keys()].sort();
  }

  // People who share an active team with `email`.
  function teammatesOf(rawEmail) {
    const ids = new Set(activeTeamIdsOf(rawEmail));
    const result = new Set();
    for (const team of load().teams) {
      if (team.archived || !ids.has(team.id)) continue;
      for (const member of team.members) result.add(member.email);
    }
    return [...result].sort();
  }

  function problem() {
    load();
    return readProblem;
  }

  // Was this address ever in a team (active, archived, removed or deleted)?
  function isKnown(rawEmail) {
    const email = access.normalizeEmail(rawEmail);
    return Boolean(email && load().known.has(email));
  }

  // Does the file know any address at all (now or ever)? Together with unreadable() this tells whether teams are in use.
  function hasKnown() {
    return load().known.size > 0;
  }

  // The file exists but was never readable: nobody can tell who is or was a participant.
  function unreadable() {
    load();
    return Boolean(readProblem && !lastGood);
  }

  /* ----- changing ----- */

  function createTeam({ name, description, budgetUsd, createdBy = null } = {}) {
    const teams = mutable();
    if (teams.length >= LIMITS.maxTeams) throw new TeamValidationError(`Es sind maximal ${LIMITS.maxTeams} Teams erlaubt.`, 'TOO_MANY_TEAMS');
    const cleanName = cleanText(name, LIMITS.maxNameLength, 'Der Teamname', { required: true });
    if (teams.some((team) => !team.archived && team.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new TeamValidationError('Ein aktives Team mit diesem Namen gibt es schon.', 'TEAM_NAME_TAKEN');
    }
    const team = {
      id: `tm-${crypto.randomBytes(6).toString('hex')}`,
      name: cleanName,
      description: cleanText(description, LIMITS.maxDescriptionLength, 'Die Beschreibung'),
      budgetUsd: cleanAmount(budgetUsd === undefined ? 0 : budgetUsd, 'Das Budget'),
      createdAt: stamp(),
      createdBy: access.normalizeEmail(createdBy),
      archived: false,
      members: []
    };
    persist([...teams, team]);
    return clone(load().byId.get(team.id));
  }

  function updateTeam(id, patch) {
    if (!isPlainObject(patch)) throw new TeamValidationError('Die Änderung muss ein Objekt sein.');
    const teams = mutable();
    const team = teams.find((entry) => entry.id === String(id));
    if (!team) throw new TeamNotFoundError(id);
    let changed = false;
    if (patch.name !== undefined) {
      team.name = cleanText(patch.name, LIMITS.maxNameLength, 'Der Teamname', { required: true });
      changed = true;
    }
    if (patch.description !== undefined) {
      team.description = cleanText(patch.description, LIMITS.maxDescriptionLength, 'Die Beschreibung');
      changed = true;
    }
    if (patch.budgetUsd !== undefined) {
      team.budgetUsd = cleanAmount(patch.budgetUsd, 'Das Budget');
      changed = true;
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== 'boolean') throw new TeamValidationError('archived muss true oder false sein.');
      team.archived = patch.archived;
      changed = true;
    }
    if (!changed) throw new TeamValidationError('Nichts zu ändern: name, description, budgetUsd oder archived angeben.');
    if (!team.archived && teams.some((entry) => entry !== team && !entry.archived && entry.name.toLowerCase() === team.name.toLowerCase())) {
      throw new TeamValidationError('Ein aktives Team mit diesem Namen gibt es schon.', 'TEAM_NAME_TAKEN');
    }
    persist(teams);
    return clone(load().byId.get(team.id));
  }

  function deleteTeam(id) {
    const teams = mutable();
    const remaining = teams.filter((team) => team.id !== String(id));
    if (remaining.length === teams.length) throw new TeamNotFoundError(id);
    persist(remaining);
    return String(id);
  }

  // `entries`: strings (an address, or a whole pasted block) as sent by the client. Reads them with the shared
  // paste parser. Returns { added, already, invalid, duplicates }.
  function addMembers(id, entries) {
    const list = Array.isArray(entries) ? entries : typeof entries === 'string' ? [entries] : null;
    if (!list || list.some((entry) => typeof entry !== 'string')) {
      throw new TeamValidationError('emails muss eine Liste von Adressen (Text) sein.', 'INVALID_EMAILS');
    }
    const parsed = emailList.parse(list.join('\n'));
    if (parsed.emails.length + parsed.invalid.length > LIMITS.maxBulk) {
      throw new TeamValidationError(`Es können höchstens ${LIMITS.maxBulk} Adressen auf einmal hinzugefügt werden.`, 'TOO_MANY_EMAILS');
    }
    if (!parsed.emails.length && !parsed.invalid.length) {
      throw new TeamValidationError('Keine E-Mail-Adresse gefunden.', 'NO_EMAILS');
    }
    const teams = mutable();
    const team = teams.find((entry) => entry.id === String(id));
    if (!team) throw new TeamNotFoundError(id);
    const present = new Set(team.members.map((member) => member.email));
    const fresh = parsed.emails.filter((email) => !present.has(email));
    if (team.members.length + fresh.length > LIMITS.maxMembersPerTeam) {
      throw new TeamValidationError(`Ein Team kann höchstens ${LIMITS.maxMembersPerTeam} Personen haben.`, 'TEAM_FULL');
    }
    const added = [];
    const already = [];
    const time = stamp();
    for (const email of parsed.emails) {
      if (present.has(email)) {
        already.push(email);
        continue;
      }
      present.add(email);
      team.members.push({ email, addedAt: time, budgetStart: time, budgetOverrideUsd: null });
      added.push(email);
    }
    if (added.length) persist(teams);
    return { added, already, invalid: parsed.invalid, duplicates: parsed.duplicates };
  }

  // patch: { budgetOverrideUsd: number | null, resetBudget: true }
  function updateMember(id, rawEmail, patch) {
    if (!isPlainObject(patch)) throw new TeamValidationError('Die Änderung muss ein Objekt sein.');
    const email = access.normalizeEmail(rawEmail);
    const teams = mutable();
    const team = teams.find((entry) => entry.id === String(id));
    if (!team) throw new TeamNotFoundError(id);
    const member = email && team.members.find((entry) => entry.email === email);
    if (!member) throw new MemberNotFoundError(rawEmail);
    let changed = false;
    if (patch.budgetOverrideUsd !== undefined) {
      member.budgetOverrideUsd = patch.budgetOverrideUsd === null ? null : cleanAmount(patch.budgetOverrideUsd, 'Das Budget der Person');
      changed = true;
    }
    if (patch.resetBudget !== undefined) {
      if (patch.resetBudget !== true) throw new TeamValidationError('resetBudget muss true sein.');
      member.budgetStart = stamp();
      changed = true;
    }
    if (!changed) throw new TeamValidationError('Nichts zu ändern: budgetOverrideUsd oder resetBudget angeben.');
    persist(teams);
    return clone(load().byId.get(team.id).members.find((entry) => entry.email === email));
  }

  function removeMember(id, rawEmail) {
    const email = access.normalizeEmail(rawEmail);
    const teams = mutable();
    const team = teams.find((entry) => entry.id === String(id));
    if (!team) throw new TeamNotFoundError(id);
    const before = team.members.length;
    team.members = team.members.filter((member) => member.email !== email);
    if (team.members.length === before) throw new MemberNotFoundError(rawEmail);
    persist(teams);
    return email;
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    file,
    listTeams,
    getTeam,
    hasTeam,
    membershipsOf,
    membershipHistoryOf,
    teamSummary,
    activeTeamIdsOf,
    activeTeams,
    teamName,
    isActiveTeam,
    activeMemberEmails,
    teammatesOf,
    problem,
    isKnown,
    hasKnown,
    unreadable,
    createTeam,
    updateTeam,
    deleteTeam,
    addMembers,
    updateMember,
    removeMember,
    onChange,
    invalidate
  };
}

const defaultStore = createTeamsStore();

module.exports = {
  TEAMS_FILE,
  LIMITS,
  CHECK_INTERVAL_MS,
  TeamValidationError,
  TeamNotFoundError,
  MemberNotFoundError,
  createTeamsStore,
  defaultStore,
  ...Object.fromEntries(
    [
      'listTeams', 'getTeam', 'hasTeam', 'membershipsOf', 'membershipHistoryOf', 'teamSummary', 'activeTeamIdsOf', 'activeTeams', 'teamName', 'isActiveTeam',
      'activeMemberEmails', 'teammatesOf', 'problem', 'isKnown', 'hasKnown', 'unreadable', 'createTeam', 'updateTeam', 'deleteTeam', 'addMembers', 'updateMember',
      'removeMember', 'onChange', 'invalidate'
    ].map((name) => [name, defaultStore[name]])
  )
};
