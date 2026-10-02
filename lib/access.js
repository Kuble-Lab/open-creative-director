'use strict';

// User management: mode, identity, roles and the access rules for chats (sessions) and node workflows.
//
// The mode is derived from the environment, there is no separate switch: user management is active
// if and only if AUTH_WHOAMI_URL is set (an external login answers who the caller is, see lib/whoami.js).
// Without it the app is the single-machine app it has always been: every caller may do everything,
// nothing has an owner and nothing is filtered.
//
// An "entry" is anything with the sharing fields: a session (chat) or a workflow.
//   owner        normalised e-mail address or null (null = existing data / anonymous creation, visible to all internal people)
//   shareMode    'private' | 'team' (everybody internal) | 'teams' (the teams in sharedTeams) | 'specific'
//   sharedWith   up to 100 normalised e-mail addresses (only meaningful for 'specific')
//   sharedTeams  up to 20 team ids (only present for 'teams')
//
// Who the caller is (identified, not an admin):
//   participant  member of at least one active team (lib/teams.js): sees only their own entries and what is shared
//                with them or their teams; no existing data, no internal resources, a USD budget (lib/budget.js)
//   internal     no team and an address of INTERNAL_EMAIL_DOMAINS (all identified people if the variable is empty)
//   guest        no team and not internal (a former participant with a session that is still valid): own and
//                personally shared entries only, no budget
// Team membership wins over the domain: an internal address in an active team is a participant.

const admins = require('./admins');

const SHARE_MODES = Object.freeze(['private', 'team', 'teams', 'specific']);
const MAX_SHARED_WITH = 100;
const MAX_SHARED_TEAMS = 20;
const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

class AccessValidationError extends Error {
  constructor(message, code = 'INVALID_SHARING') {
    super(message);
    this.name = 'AccessValidationError';
    this.code = code;
  }
}

// Something a participant or guest may not use (GTS, brandings, Higgsfield, the ChatGPT subscription ...).
// `feature` names it for the client (gts, brandings, higgsfield, chatgpt, roles).
class RoleRestrictedError extends Error {
  constructor(feature, message, messageDe) {
    super(message || `${feature} is not available for your account`);
    this.name = 'RoleRestrictedError';
    this.code = 'FORBIDDEN_FOR_ROLE';
    this.status = 403;
    this.feature = feature;
    this.messageDe = messageDe || `${feature} ist für dein Konto nicht verfügbar.`;
  }
}

// The login could not be confirmed while a restriction is active (see restrictionActive): the caller is anonymous
// although people with a login (participants, guests) may be among the callers. Answered with 401.
const LOGIN_UNCONFIRMED_MESSAGES = Object.freeze({
  de: 'Deine Anmeldung konnte gerade nicht bestätigt werden. Bitte lade die Seite neu.',
  en: 'Your sign-in could not be confirmed right now. Please reload the page.',
  es: 'No se pudo confirmar tu inicio de sesión en este momento. Recarga la página.'
});

class LoginUnconfirmedError extends Error {
  constructor() {
    super(LOGIN_UNCONFIRMED_MESSAGES.en);
    this.name = 'LoginUnconfirmedError';
    this.code = 'LOGIN_UNCONFIRMED';
    this.status = 401;
    this.messageDe = LOGIN_UNCONFIRMED_MESSAGES.de;
    this.messages = LOGIN_UNCONFIRMED_MESSAGES;
  }
}

/* ---------- mode ---------- */

function isActive(env = process.env) {
  return Boolean(String(env.AUTH_WHOAMI_URL || '').trim());
}

/* ---------- identity ---------- */

// Lenient, non-throwing e-mail normalisation. Returns null for anything that is not an address
// (in particular the placeholder 'lokal' that lib/whoami.js uses for "nobody").
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  const at = email.indexOf('@');
  const dot = email.lastIndexOf('.');
  if (!email || at <= 0 || at !== email.lastIndexOf('@') || dot <= at + 1 || dot >= email.length - 1 || /\s/.test(email)) return null;
  return [...email].length > 254 ? null : email;
}

function normalizeEmailList(values, max = MAX_SHARED_WITH) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeEmail).filter(Boolean))].slice(0, max);
}

function normalizeIdList(values, max = MAX_SHARED_TEAMS) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string' && TEAM_ID_PATTERN.test(value)))].slice(0, max);
}

/* ---------- teams and internal addresses ---------- */

// The teams store is required lazily (lib/teams.js needs this file) and can be replaced in tests.
let teamsOverride = null;
function teamsStore() {
  return teamsOverride || require('./teams').defaultStore;
}

// Test hook: use another teams store (or null for the default one).
function useTeamsStore(store) {
  teamsOverride = store || null;
}

// INTERNAL_EMAIL_DOMAINS: comma-separated domains ("example.com", a leading @ is fine). Empty = every identified
// person without a team counts as internal (the behaviour before teams existed), except people the teams know
// (see isInternalPerson): without a domain list a former participant cannot be told from a colleague.
function internalDomains(env = process.env) {
  return [...new Set(String(env.INTERNAL_EMAIL_DOMAINS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter((entry) => entry && !/[\s@]/.test(entry)))];
}

function isInternalEmail(email, env = process.env) {
  const clean = normalizeEmail(email);
  if (!clean) return false;
  const domains = internalDomains(env);
  return domains.length === 0 || domains.includes(clean.slice(clean.indexOf('@') + 1));
}

// The kind of a person without an active team. With INTERNAL_EMAIL_DOMAINS the domain decides. Without it everybody
// is internal, EXCEPT addresses that are or were in any team (archived teams, removed members, deleted teams) and
// everybody when the teams file cannot be read at all: those people are guests (fail closed). Set the variable in
// every installation that uses teams.
function isInternalPerson(email, env = process.env) {
  const clean = normalizeEmail(email);
  if (!clean) return false;
  if (internalDomains(env).length) return isInternalEmail(clean, env);
  try {
    const store = teamsStore();
    return !(store.unreadable() || store.isKnown(clean));
  } catch (_) {
    return false;
  }
}

function membershipsOf(email) {
  try {
    return teamsStore().membershipsOf(email);
  } catch (_) {
    return [];
  }
}

// SUPERADMIN_EMAILS: environment only, any domain, never editable through the UI or the API.
function superadminEmails(env = process.env) {
  return normalizeEmailList(String(env.SUPERADMIN_EMAILS || '').split(','), 1000);
}

function isAdminEmail(email, env = process.env) {
  const clean = normalizeEmail(email);
  if (!clean) return false;
  if (superadminEmails(env).includes(clean)) return true;
  if (admins.envAdminEmails(env).includes(clean)) return true;
  try {
    return admins.listStoredAdmins().includes(clean);
  } catch (_) {
    return false;
  }
}

// Memoised isAdminEmail for code that checks many owners in one go (lists).
function createAdminLookup(env = process.env) {
  const memo = new Map();
  return (email) => {
    const clean = normalizeEmail(email);
    if (!clean) return false;
    if (!memo.has(clean)) memo.set(clean, isAdminEmail(clean, env));
    return memo.get(clean);
  };
}

const LOCAL_VIEWER = Object.freeze({ active: false, email: null, identified: false, admin: true, superadmin: false });

// The caller of a request. Computed once per request object. In the local mode everything is allowed.
// In the active mode a request without a valid e-mail (whoami failed, direct access to the port) is
// anonymous: identified is false, admin is false.
function viewerOf(req, env = process.env) {
  if (!isActive(env)) return LOCAL_VIEWER;
  const cached = req && typeof req === 'object' ? req.__accessViewer : null;
  if (cached && cached.raw === req.kubleUser && cached.env === env) return cached.viewer;
  const email = normalizeEmail(req?.kubleUser);
  const superadmin = Boolean(email && superadminEmails(env).includes(email));
  const admin = superadmin || isAdminEmail(email, env);
  const base = { active: true, email, identified: Boolean(email), superadmin, admin };
  let viewer;
  if (!email) {
    viewer = Object.freeze(base); // anonymous: nothing but the ownerless data
  } else if (admin) {
    viewer = Object.freeze({ ...base, kind: 'admin', teamIds: [] });
  } else {
    const memberships = membershipsOf(email);
    const kind = memberships.length ? 'participant' : isInternalPerson(email, env) ? 'internal' : 'guest';
    viewer = Object.freeze({ ...base, kind, teamIds: Object.freeze(memberships.map((entry) => entry.teamId)) });
  }
  if (req && typeof req === 'object') {
    try {
      Object.defineProperty(req, '__accessViewer', { value: { raw: req.kubleUser, env, viewer }, configurable: true, writable: true });
    } catch (_) {
      /* frozen request object: recompute next time */
    }
  }
  return viewer;
}

function roleOf(viewer) {
  if (!viewer.active) return 'local';
  if (viewer.superadmin) return 'superadmin';
  if (viewer.admin) return 'admin';
  if (viewer.kind === 'participant') return 'participant';
  if (viewer.kind === 'guest') return 'guest';
  return viewer.identified ? 'user' : 'anonymous';
}

const isParticipant = (viewer) => Boolean(viewer && viewer.active && viewer.kind === 'participant');
const isGuest = (viewer) => Boolean(viewer && viewer.active && viewer.kind === 'guest');
// Participants and guests: no existing data, no internal resources (GTS, brandings, custom templates, roles ...),
// no ChatGPT subscription and no Higgsfield.
const isRestricted = (viewer) => isParticipant(viewer) || isGuest(viewer);

// "Restriction active": the installation has (or had) restricted people, so an anonymous caller cannot be taken for
// an harmless local visitor. True in the active mode when at least one of these holds:
//   - the teams file knows any address (a team member exists or existed);
//   - the teams file cannot be read (nobody can tell who is a participant);
//   - INTERNAL_EMAIL_DOMAINS is set (people outside the domains are guests).
// Without any of them (no teams ever, no domain list) and in the local mode nothing changes.
function restrictionActive(env = process.env) {
  if (!isActive(env)) return false;
  if (internalDomains(env).length) return true;
  try {
    const store = teamsStore();
    if (store.unreadable()) return true;
    return typeof store.hasKnown === 'function' ? Boolean(store.hasKnown()) : false;
  } catch (_) {
    return true; // fail closed
  }
}

// An anonymous caller while a restriction is active: whoami failed or the session is missing, the person may well
// be a participant. Such a request is refused on every API route except the public ones (unconfirmedExempt).
function isUnconfirmed(viewer, env = process.env) {
  return Boolean(viewer && viewer.active && !viewer.email && restrictionActive(env));
}

// Routes that answer even for an unconfirmed caller: the ones with the rule 'public' in scripts/support/route-rules.js
// under /api, plus GET /api/config (filtered like for guests). The app shell and static files are not under /api;
// the files of chats (/assets) are guarded like the API (/refs, the public provider URLs, is not).
const UNCONFIRMED_EXEMPT_PATHS = Object.freeze([
  '/api/me',
  '/api/nodes/registry',
  '/api/workflow-templates',
  '/api/roles/default',
  '/api/config'
]);

function unconfirmedExempt(method, urlPath) {
  const verb = String(method || '').toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return false;
  const clean = String(urlPath || '').toLowerCase().replace(/\/+$/, '');
  return UNCONFIRMED_EXEMPT_PATHS.includes(clean);
}

// Express middleware, mounted right after the whoami middleware and before every other route (streams included).
function createUnconfirmedGuard(env = process.env) {
  return function unconfirmedGuard(req, res, next) {
    const urlPath = String(req.path || '');
    if (!/^\/(api|assets)(\/|$)/i.test(urlPath)) return next();
    if (unconfirmedExempt(req.method, urlPath)) return next();
    let blocked = false;
    try {
      blocked = isUnconfirmed(viewerOf(req, env), env);
    } catch (_) {
      blocked = isActive(env) && !normalizeEmail(req.kubleUser); // fail closed
    }
    if (!blocked) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({
      error: LOGIN_UNCONFIRMED_MESSAGES.de,
      code: 'LOGIN_UNCONFIRMED',
      messages: LOGIN_UNCONFIRMED_MESSAGES
    });
  };
}
const CHATGPT_MODEL_PREFIX = 'chatgpt/';
function modelAllowed(viewer, model) {
  return !isRestricted(viewer) || !String(model || '').startsWith(CHATGPT_MODEL_PREFIX);
}

// config.restrictedBrainModels: when the list is not empty, participants and guests may use only these brain models.
// Everybody else (and every list that is empty or missing) is not affected.
function brainModelAllowed(viewer, model, restrictedModels) {
  const list = Array.isArray(restrictedModels) ? restrictedModels : [];
  return !isRestricted(viewer) || list.length === 0 || list.includes(String(model || ''));
}

// The brain model a request really gets: its own when allowed, else the default (if that is on the list) or the first
// listed model. Returns { model, changed }.
function brainModelFor(viewer, model, { restrictedModels = [], defaultBrain = '' } = {}) {
  if (brainModelAllowed(viewer, model, restrictedModels)) return { model, changed: false };
  const list = restrictedModels;
  return { model: list.includes(defaultBrain) ? defaultBrain : list[0], changed: true };
}

/* ---------- sharing fields ---------- */

function sharingOf(entry) {
  const shareMode = SHARE_MODES.includes(entry?.shareMode) ? entry.shareMode : 'private';
  const sharing = {
    owner: normalizeEmail(entry?.owner),
    shareMode,
    sharedWith: normalizeEmailList(entry?.sharedWith)
  };
  // Only entries shared with teams carry the field, so everything else keeps the shape it always had.
  if (shareMode === 'teams') sharing.sharedTeams = normalizeIdList(entry?.sharedTeams);
  return sharing;
}

// Normalises the sharing fields of a loaded entry in place (old files without the fields stay valid).
function normaliseSharing(entry) {
  const sharing = sharingOf(entry);
  Object.assign(entry, sharing);
  if (!('sharedTeams' in sharing)) delete entry.sharedTeams;
  return entry;
}

/* ---------- rules ---------- */

// See, open, chat on, edit and run.
//   admin:        everything
//   internal:     no owner (existing data), the owner, 'team' (every internal person) or 'specific' and listed
//   participant:  the owner, 'teams' with a team in common, or 'specific' and listed. Never existing data, never 'team'.
//   guest:        the owner or 'specific' and listed
//   anonymous:    only what has no owner
function canUse(entry, viewer) {
  if (!viewer.active || viewer.admin) return true;
  const sharing = sharingOf(entry);
  if (isRestricted(viewer)) {
    if (!sharing.owner || !viewer.email) return false;
    if (sharing.owner === viewer.email) return true;
    if (sharing.shareMode === 'specific') return sharing.sharedWith.includes(viewer.email);
    return isParticipant(viewer) && sharing.shareMode === 'teams' && sharing.sharedTeams.some((id) => viewer.teamIds.includes(id));
  }
  if (!sharing.owner) return true;
  if (!viewer.email) return false;
  if (sharing.owner === viewer.email) return true;
  if (sharing.shareMode === 'team') return true;
  return sharing.shareMode === 'specific' && sharing.sharedWith.includes(viewer.email);
}

// Rename, move to a folder, delete: admin or owner. Entries without an owner stay open to every internal person (as
// before); participants and guests never see them.
function canManage(entry, viewer) {
  if (!viewer.active || viewer.admin) return true;
  const { owner } = sharingOf(entry);
  if (!owner) return !isRestricted(viewer);
  return Boolean(viewer.email) && owner === viewer.email;
}

// Change the sharing: admin or owner. Entries without an owner: admins only (they become the owner).
function canShare(entry, viewer) {
  if (!viewer.active) return false;
  if (viewer.admin) return true;
  const { owner } = sharingOf(entry);
  return Boolean(owner && viewer.email && owner === viewer.email);
}

// The owner to store for something the viewer creates: their address, or null when anonymous / local.
function ownerForNew(viewer) {
  return viewer.active && viewer.email ? viewer.email : null;
}

// What a caller may pick when sharing: the sharing modes, which people (the team list, or the teammates of a
// participant) and which teams. `isKnownMember` is the team-list check of the caller's side (lib/users.js).
//   admin / internal   every mode; any person of the team list; any active team
//   participant        private, teams (their own teams) and specific (members of their own teams)
//   guest              private only
function sharingPolicy(viewer, { isKnownMember = () => true } = {}) {
  if (!viewer || !viewer.active) return { allowedModes: SHARE_MODES.slice(), isKnownMember, isKnownTeam: () => true };
  if (isParticipant(viewer)) {
    const mates = new Set(teamsStore().teammatesOf(viewer.email));
    return {
      allowedModes: ['private', 'teams', 'specific'],
      isKnownMember: (email) => mates.has(email),
      isKnownTeam: (id) => viewer.teamIds.includes(id)
    };
  }
  if (isGuest(viewer)) {
    return { allowedModes: ['private'], isKnownMember: () => false, isKnownTeam: () => false };
  }
  return {
    allowedModes: SHARE_MODES.slice(),
    isKnownMember,
    isKnownTeam: (id) => teamsStore().isActiveTeam(id)
  };
}

// Validates a sharing request and returns the fields to store. `isKnownMember(email)` decides which addresses
// may be picked (the team list); addresses that are already shared with stay valid even if the person left the list.
// `policy` (sharingPolicy) additionally restricts the modes and the teams; teams that are already shared with stay valid.
function buildSharing(request, current, isKnownMember = () => true, policy = {}) {
  const body = request && typeof request === 'object' ? request : {};
  if (!SHARE_MODES.includes(body.shareMode)) {
    throw new AccessValidationError('shareMode must be private, team, teams or specific');
  }
  if (Array.isArray(policy.allowedModes) && !policy.allowedModes.includes(body.shareMode)) {
    throw new AccessValidationError(`The sharing mode ${body.shareMode} is not available for your account`, 'SHARE_MODE_FORBIDDEN');
  }
  let sharedWith = [];
  let sharedTeams = null;
  if (body.shareMode === 'specific') {
    if (!Array.isArray(body.sharedWith)) throw new AccessValidationError('sharedWith must be a list of e-mail addresses');
    if (body.sharedWith.length > MAX_SHARED_WITH) {
      throw new AccessValidationError(`At most ${MAX_SHARED_WITH} people can be selected`);
    }
    const invalid = body.sharedWith.filter((value) => !normalizeEmail(value));
    if (invalid.length) throw new AccessValidationError('sharedWith contains invalid e-mail addresses');
    sharedWith = normalizeEmailList(body.sharedWith);
    const before = new Set(sharingOf(current).sharedWith);
    const unknown = sharedWith.filter((email) => !before.has(email) && !isKnownMember(email));
    if (unknown.length) {
      throw new AccessValidationError(`Unknown team members: ${unknown.join(', ')}`, 'UNKNOWN_TEAM_MEMBERS');
    }
    if (!sharedWith.length) throw new AccessValidationError('Select at least one person or choose private');
  }
  if (body.shareMode === 'teams') {
    if (!Array.isArray(body.sharedTeams)) throw new AccessValidationError('sharedTeams must be a list of team ids');
    if (body.sharedTeams.length > MAX_SHARED_TEAMS) {
      throw new AccessValidationError(`At most ${MAX_SHARED_TEAMS} teams can be selected`);
    }
    if (body.sharedTeams.some((id) => typeof id !== 'string' || !TEAM_ID_PATTERN.test(id))) {
      throw new AccessValidationError('sharedTeams contains invalid team ids');
    }
    sharedTeams = normalizeIdList(body.sharedTeams);
    const isKnownTeam = typeof policy.isKnownTeam === 'function' ? policy.isKnownTeam : () => true;
    const before = new Set(Array.isArray(current?.sharedTeams) ? current.sharedTeams : []);
    const unknown = sharedTeams.filter((id) => !before.has(id) && !isKnownTeam(id));
    if (unknown.length) throw new AccessValidationError(`Unknown teams: ${unknown.join(', ')}`, 'UNKNOWN_TEAMS');
    if (!sharedTeams.length) throw new AccessValidationError('Select at least one team or choose private');
  }
  return { shareMode: body.shareMode, sharedWith, ...(sharedTeams ? { sharedTeams } : {}) };
}

// The fields a response carries for a viewer in the active mode. sharedWith itself is only revealed to the
// people who may change it; everybody else gets the number.
// Entries shared with teams also carry sharedTeams [{ id, name }]: all of them for those who may change the sharing,
// only the viewer's own teams for everybody else.
function describe(entry, viewer, adminLookup = isAdminEmail) {
  const sharing = sharingOf(entry);
  const manage = canManage(entry, viewer);
  const share = canShare(entry, viewer);
  const result = {
    owner: sharing.owner,
    ownerIsAdmin: sharing.owner ? adminLookup(sharing.owner) : false,
    unowned: !sharing.owner,
    mine: Boolean(viewer.email && sharing.owner === viewer.email),
    shareMode: sharing.shareMode,
    sharedCount: sharing.shareMode === 'specific' ? sharing.sharedWith.length : 0,
    canManage: manage,
    canShare: share
  };
  if (share || (viewer.email && sharing.owner === viewer.email)) result.sharedWith = sharing.sharedWith;
  if (sharing.shareMode === 'teams') {
    const owner = share || (viewer.email && sharing.owner === viewer.email);
    const visible = owner || viewer.admin ? sharing.sharedTeams : sharing.sharedTeams.filter((id) => (viewer.teamIds || []).includes(id));
    const store = teamsStore();
    result.sharedTeamCount = sharing.sharedTeams.length;
    result.sharedTeams = visible.map((id) => ({ id, name: store.teamName(id) })).filter((team) => team.name);
  }
  return result;
}

module.exports = {
  SHARE_MODES,
  MAX_SHARED_WITH,
  MAX_SHARED_TEAMS,
  AccessValidationError,
  LOCAL_VIEWER,
  isActive,
  normalizeEmail,
  normalizeEmailList,
  normalizeIdList,
  internalDomains,
  isInternalEmail,
  isInternalPerson,
  useTeamsStore,
  teamsStore,
  RoleRestrictedError,
  LoginUnconfirmedError,
  LOGIN_UNCONFIRMED_MESSAGES,
  restrictionActive,
  isUnconfirmed,
  unconfirmedExempt,
  UNCONFIRMED_EXEMPT_PATHS,
  createUnconfirmedGuard,
  isParticipant,
  isGuest,
  isRestricted,
  modelAllowed,
  brainModelAllowed,
  brainModelFor,
  sharingPolicy,
  superadminEmails,
  isAdminEmail,
  createAdminLookup,
  viewerOf,
  roleOf,
  sharingOf,
  normaliseSharing,
  canUse,
  canManage,
  canShare,
  ownerForNew,
  buildSharing,
  describe
};
