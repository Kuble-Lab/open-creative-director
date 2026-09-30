'use strict';

// User management: mode, identity, roles and the access rules for chats (sessions) and node workflows.
//
// The mode is derived from the environment, there is no separate switch: user management is active
// if and only if AUTH_WHOAMI_URL is set (an external login answers who the caller is, see lib/whoami.js).
// Without it the app is the single-machine app it has always been: every caller may do everything,
// nothing has an owner and nothing is filtered.
//
// An "entry" is anything with the sharing fields: a session (chat) or a workflow.
//   owner       normalised e-mail address or null (null = existing data / anonymous creation, visible to all)
//   shareMode   'private' | 'team' | 'specific'
//   sharedWith  up to 100 normalised e-mail addresses (only meaningful for 'specific')

const admins = require('./admins');

const SHARE_MODES = Object.freeze(['private', 'team', 'specific']);
const MAX_SHARED_WITH = 100;

class AccessValidationError extends Error {
  constructor(message, code = 'INVALID_SHARING') {
    super(message);
    this.name = 'AccessValidationError';
    this.code = code;
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
  const viewer = Object.freeze({
    active: true,
    email,
    identified: Boolean(email),
    superadmin,
    admin: superadmin || isAdminEmail(email, env)
  });
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
  return viewer.identified ? 'user' : 'anonymous';
}

/* ---------- sharing fields ---------- */

function sharingOf(entry) {
  const shareMode = SHARE_MODES.includes(entry?.shareMode) ? entry.shareMode : 'private';
  return {
    owner: normalizeEmail(entry?.owner),
    shareMode,
    sharedWith: normalizeEmailList(entry?.sharedWith)
  };
}

// Normalises the sharing fields of a loaded entry in place (old files without the fields stay valid).
function normaliseSharing(entry) {
  Object.assign(entry, sharingOf(entry));
  return entry;
}

/* ---------- rules ---------- */

// See, open, chat on, edit and run: admin, or no owner, or the owner, or 'team' (any identified person),
// or 'specific' and listed.
function canUse(entry, viewer) {
  if (!viewer.active || viewer.admin) return true;
  const sharing = sharingOf(entry);
  if (!sharing.owner) return true;
  if (!viewer.email) return false;
  if (sharing.owner === viewer.email) return true;
  if (sharing.shareMode === 'team') return true;
  return sharing.shareMode === 'specific' && sharing.sharedWith.includes(viewer.email);
}

// Rename, move to a folder, delete: admin or owner. Entries without an owner stay open to everyone (as before).
function canManage(entry, viewer) {
  if (!viewer.active || viewer.admin) return true;
  const { owner } = sharingOf(entry);
  if (!owner) return true;
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

// Validates a sharing request and returns the fields to store. `isKnownMember(email)` decides which addresses
// may be picked (the team list); addresses that are already shared with stay valid even if the person left the list.
function buildSharing(request, current, isKnownMember = () => true) {
  const body = request && typeof request === 'object' ? request : {};
  if (!SHARE_MODES.includes(body.shareMode)) {
    throw new AccessValidationError('shareMode must be private, team or specific');
  }
  let sharedWith = [];
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
  return { shareMode: body.shareMode, sharedWith };
}

// The fields a response carries for a viewer in the active mode. sharedWith itself is only revealed to the
// people who may change it; everybody else gets the number.
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
  return result;
}

module.exports = {
  SHARE_MODES,
  MAX_SHARED_WITH,
  AccessValidationError,
  LOCAL_VIEWER,
  isActive,
  normalizeEmail,
  normalizeEmailList,
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
