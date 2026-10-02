'use strict';

// Chats and workflows grouped by team (WP22). Admins see everything; the grouping shows which training an entry
// belongs to. Only admins of the user management get any of it (isAllowed): the team a person is in is confidential.
//
// Where an entry belongs:
//   teamId stored   a chat or workflow created with user management stores the creator's team (teamForNew: the
//                   active team joined last). Only the server sets it; no request can. It wins as long as the team
//                   exists; a deleted team sends the entry to "internal".
//   no teamId       old data. Decisive is the team of the owner when the entry was created: the membership with the
//                   latest addedAt that is not later than createdAt (archived teams count), else the earliest later
//                   one. Removing a person from a team takes the derived assignment away again.
//   otherwise       "internal" (id 'none'): owner without team, guests, old data without an owner.

const access = require('./access');

const NONE = 'none';
const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Local mode and everybody who is not an admin of the active user management get no team information.
function isAllowed(viewer) {
  return Boolean(viewer && viewer.active && viewer.admin);
}

// The team to store for something `viewer` creates: the active team they joined last, or null.
function teamForNew(viewer, store = access.teamsStore()) {
  if (!viewer || !viewer.active || !viewer.email) return null;
  let memberships = [];
  try {
    memberships = store.membershipsOf(viewer.email);
  } catch (_) {
    return null;
  }
  let latest = null;
  for (const entry of memberships) {
    if (!latest || String(entry.addedAt) >= String(latest.addedAt)) latest = entry;
  }
  return latest ? latest.teamId : null;
}

// Resolves entries ({ owner, teamId, createdAt }) to a team id (or null = internal). Memoises per owner and team, so
// a list of thousands of entries costs one lookup per person.
function createResolver(store = access.teamsStore()) {
  const histories = new Map();
  const summaries = new Map();

  function summary(id) {
    if (!summaries.has(id)) summaries.set(id, store.teamSummary(id));
    return summaries.get(id);
  }

  function historyOf(owner) {
    if (!histories.has(owner)) {
      histories.set(
        owner,
        store.membershipHistoryOf(owner).map((entry) => ({ teamId: entry.teamId, at: Date.parse(entry.addedAt) }))
      );
    }
    return histories.get(owner);
  }

  function teamIdOf(entry) {
    const stored = typeof entry?.teamId === 'string' && TEAM_ID_PATTERN.test(entry.teamId) ? entry.teamId : null;
    if (stored) return summary(stored) ? stored : null;
    const owner = access.normalizeEmail(entry?.owner);
    const created = Date.parse(entry?.createdAt);
    if (!owner || !Number.isFinite(created)) return null;
    let before = null;
    let after = null;
    for (const membership of historyOf(owner)) {
      if (membership.at <= created) before = membership;
      else if (!after) after = membership;
    }
    return (before || after)?.teamId || null;
  }

  // The team as an entry carries it: null for "internal".
  function ref(teamId) {
    const info = teamId ? summary(teamId) : null;
    return info ? { id: info.id, name: info.name, archived: info.archived } : null;
  }

  return { teamIdOf, ref, summary };
}

// rows: [{ teamId, updatedAt, owner }] (teamId already resolved). The groups in display order: active teams by the
// latest activity of their entries, then archived teams, then "internal" last. Teams without entries are not listed.
// people: members of the team; for "internal" the number of different owners.
function buildGroups(rows, resolver) {
  const map = new Map();
  for (const row of rows) {
    const id = row.teamId || NONE;
    if (!map.has(id)) map.set(id, { id, count: 0, lastActivity: '', owners: new Set() });
    const group = map.get(id);
    group.count += 1;
    const changed = String(row.updatedAt || '');
    if (changed > group.lastActivity) group.lastActivity = changed;
    if (row.owner) group.owners.add(row.owner);
  }
  const groups = [...map.values()].map((group) => {
    const info = group.id === NONE ? null : resolver.summary(group.id);
    return {
      id: group.id,
      name: info ? info.name : null,
      archived: Boolean(info && info.archived),
      internal: group.id === NONE,
      count: group.count,
      people: info ? info.memberCount : group.owners.size,
      lastActivity: group.lastActivity || null
    };
  });
  const rank = (group) => (group.internal ? 2 : group.archived ? 1 : 0);
  groups.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'de-CH', { sensitivity: 'base' })
  );
  return groups;
}

module.exports = { NONE, TEAM_ID_PATTERN, isAllowed, teamForNew, createResolver, buildGroups };
