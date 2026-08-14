'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { PATHS } = require('./config');

const COSTS_FILE = path.join(PATHS.root, 'data', 'costs.jsonl');
const VALID_TYPES = new Set(['image', 'video', 'motion', 'brain', 'higgsfield']);
const ZURICH_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function finiteCost(value) {
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function normaliseEntry(entry) {
  const cost = finiteCost(entry?.cost);
  const ts = new Date(entry?.ts);
  const sessionId = String(entry?.sessionId || '').trim();
  const type = String(entry?.type || '').trim();
  const model = String(entry?.model || '').trim();
  const user = String(entry?.user || '').trim();
  if (Number.isNaN(ts.getTime())) throw new Error('Ungueltiger Kosten-Zeitstempel');
  if (!sessionId) throw new Error('sessionId fehlt');
  if (!VALID_TYPES.has(type)) throw new Error(`Ungueltiger Kosten-Typ: ${type}`);
  if (!model) throw new Error('model fehlt');
  if (cost === null) throw new Error('cost muss eine nicht-negative Zahl sein');
  if (!user) throw new Error('user fehlt');

  const clean = {
    ts: ts.toISOString(),
    sessionId,
    type,
    model,
    cost,
    user
  };
  const assetId = String(entry?.assetId || '').trim();
  if (assetId) clean.assetId = assetId;
  return clean;
}

async function recordCost(entry, file = COSTS_FILE) {
  const clean = normaliseEntry(entry);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(clean)}\n`, 'utf8');
  return clean;
}

async function readCosts(file = COSTS_FILE) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(normaliseEntry(JSON.parse(line)));
    } catch (_) {
      /* Kaputte oder unvollstaendige Journalzeilen ueberspringen. */
    }
  }
  return entries;
}

function zurichDateParts(value) {
  const parts = {};
  for (const part of ZURICH_DATE.formatToParts(new Date(value))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function isoWeekKey(value) {
  const { year, month, day } = zurichDateParts(value);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const weekYear = date.getUTCFullYear();
  const firstDay = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((date - firstDay) / 86400000) + 1) / 7);
  return `${weekYear}-KW${String(week).padStart(2, '0')}`;
}

function monthKey(value) {
  const { year, month } = zurichDateParts(value);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function addGroup(map, key, cost) {
  const current = map.get(key) || { total: 0, count: 0 };
  current.total += cost;
  current.count += 1;
  map.set(key, current);
}

function summariseCosts(entries, { now = new Date(), sessionTitles = {} } = {}) {
  const currentMonthKey = monthKey(now);
  const currentWeekKey = isoWeekKey(now);
  const months = new Map();
  const weeks = new Map();
  const users = new Map();
  const types = new Map();
  const sessions = new Map();
  let total = 0;

  for (const raw of Array.isArray(entries) ? entries : []) {
    let entry;
    try {
      entry = normaliseEntry(raw);
    } catch (_) {
      continue;
    }
    total += entry.cost;
    addGroup(months, monthKey(entry.ts), entry.cost);
    addGroup(weeks, isoWeekKey(entry.ts), entry.cost);
    addGroup(users, entry.user, entry.cost);
    addGroup(types, entry.type, entry.cost);
    addGroup(sessions, entry.sessionId, entry.cost);
  }

  const byMonth = [...months.entries()]
    .map(([month, value]) => ({ month, total: value.total }))
    .sort((a, b) => b.month.localeCompare(a.month));
  const byWeek = [...weeks.entries()]
    .map(([week, value]) => ({ week, total: value.total }))
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, 8);
  const byUser = [...users.entries()]
    .map(([user, value]) => ({ user, total: value.total }))
    .sort((a, b) => b.total - a.total || a.user.localeCompare(b.user));
  const byType = [...types.entries()]
    .map(([type, value]) => ({ type, total: value.total, count: value.count }))
    .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
  const bySession = [...sessions.entries()]
    .map(([sessionId, value]) => ({
      sessionId,
      ...(sessionTitles[sessionId] ? { title: sessionTitles[sessionId] } : {}),
      total: value.total
    }))
    .sort((a, b) => b.total - a.total || a.sessionId.localeCompare(b.sessionId))
    .slice(0, 10);

  return {
    total,
    currentMonth: months.get(currentMonthKey)?.total || 0,
    currentWeek: weeks.get(currentWeekKey)?.total || 0,
    byMonth,
    byWeek,
    byUser,
    byType,
    bySession
  };
}

module.exports = {
  COSTS_FILE,
  VALID_TYPES,
  recordCost,
  readCosts,
  summariseCosts,
  monthKey,
  isoWeekKey
};
