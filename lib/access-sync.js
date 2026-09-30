'use strict';

// Optional sync of the team members into the allowlist of the login in front of the app (WP15).
//
// The login (an auth proxy in front of the app) admits the addresses of the company domain plus the addresses in
// `extra_emails` of a route. Participants of a training have other addresses, so their team membership has to
// reach that list. Only with both variables set does anything happen:
//   ACCESS_ALLOWLIST_FILE   path to the JSON file of the login: { default: {...}, routes: [{ path, public?, extra_emails: [] }] }
//   ACCESS_ALLOWLIST_ROUTE  the route to maintain, e.g. /training
//
// After every change of the teams (member added or removed, team archived or deleted) `extra_emails` of that route holds
// exactly the manually maintained addresses plus everybody in an active team. Addresses of INTERNAL_EMAIL_DOMAINS
// are not entered (the login admits the whole domain anyway). Manually maintained entries are never removed: the
// addresses this module put there are remembered in data/access-sync.json, everything else counts as manual.
//
// The file is written atomically (temporary file next to the real target of a symlink, then rename; permissions and,
// where allowed, owner are kept; a file that cannot be replaced, such as a bind-mounted single file, is written in
// place instead), and once before the first change a copy <file>.bak-<timestamp> is made. The record of what this
// module entered is written BEFORE the list changes (a failed write can then never turn synchronised addresses into
// manual ones) and is kept twice: data/access-sync.json and a copy next to the list. A record that exists but is
// unreadable stops the sync with a warning instead of counting as empty. A missing route is created with
// { path, public: false, extra_emails }; other routes and `default` are left as they are. A failure is logged and
// reported through status() (the admin UI shows it as a warning); the app stays usable.

const fs = require('fs');
const path = require('path');

const access = require('./access');
const { PATHS } = require('./config');

const STATE_FILE = path.join(PATHS.root, 'data', 'access-sync.json');

// Replaces `file` atomically. A symlink is followed (the link stays, its target is replaced), the owner is kept where the
// process may set it, and where rename() is impossible (a single file mounted into a container: EBUSY, EXDEV, EPERM) the
// content is written in place.
function writeAtomic(file, text, mode, owner = null) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch (_) {
    /* the file does not exist yet */
  }
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, text, { encoding: 'utf8', mode });
  try {
    fs.chmodSync(temporary, mode);
    if (owner) {
      try {
        fs.chownSync(temporary, owner.uid, owner.gid);
      } catch (_) {
        /* not allowed for this process: the owner of the new file stays this process */
      }
    }
    fs.renameSync(temporary, target);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    if (['EBUSY', 'EXDEV', 'EPERM', 'EACCES'].includes(err.code) && fs.existsSync(target)) {
      fs.writeFileSync(target, text, { encoding: 'utf8' });
      return;
    }
    throw err;
  }
}

function createAccessSync({ teams = () => access.teamsStore(), env = process.env, stateFile = STATE_FILE, now = Date.now } = {}) {
  let chain = Promise.resolve();
  let last = { lastRunAt: null, lastOk: null, lastError: null, lastChangeAt: null };

  const settings = () => ({
    file: String(env.ACCESS_ALLOWLIST_FILE || '').trim(),
    route: String(env.ACCESS_ALLOWLIST_ROUTE || '').trim()
  });

  function enabled() {
    const { file, route } = settings();
    return Boolean(file && route);
  }

  // The copy of the record next to the list of the login survives a lost or restored data/ folder.
  function stateCopyFile() {
    const { file } = settings();
    return file ? path.join(path.dirname(file), `.${path.basename(file)}.access-sync.json`) : null;
  }

  // One record file: null = missing, throws for a file that exists but is not a JSON object.
  function readRecord(recordFile) {
    if (!recordFile) return null;
    let raw;
    try {
      raw = fs.readFileSync(recordFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  }

  // What this module entered earlier. Missing everywhere = first run ({}). A record that exists but cannot be read
  // (and has no readable twin) is an error: treating it as empty would turn every synchronised address into a manual one.
  function readState({ strict = false } = {}) {
    let primary = null;
    let primaryError = null;
    try {
      primary = readRecord(stateFile);
    } catch (err) {
      primaryError = err;
    }
    let copy = null;
    let copyError = null;
    try {
      copy = readRecord(stateCopyFile());
    } catch (err) {
      copyError = err;
    }
    const usable = primary || copy;
    if (usable) {
      // The newer of the two wins (the primary may have been restored from an old backup).
      if (primary && copy) return Date.parse(copy.lastRunAt) > Date.parse(primary.lastRunAt) ? copy : primary;
      return usable;
    }
    if ((primaryError || copyError) && strict) {
      throw new Error(`Der Sync-Status (${primaryError ? path.basename(stateFile) : path.basename(stateCopyFile())}) ist unlesbar; die Freigabeliste wird nicht verändert, bis er repariert oder entfernt ist.`);
    }
    return {};
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    const copy = stateCopyFile();
    if (copy) {
      try {
        writeAtomic(copy, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      } catch (_) {
        /* the copy is a safety net only */
      }
    }
  }

  const emailsOf = (list) => (Array.isArray(list) ? list : []).map(access.normalizeEmail).filter(Boolean);

  // One run: reads the file, computes the list, writes only if it changes. Returns { ok, changed, ... }.
  function runOnce() {
    const { file, route } = settings();
    if (!file || !route) return { ok: true, enabled: false, changed: false };
    let state = {};
    let stateRead = false;
    const startedAt = new Date(now()).toISOString();
    try {
      state = readState({ strict: true });
      stateRead = true;
      if (!route.startsWith('/')) throw new Error('ACCESS_ALLOWLIST_ROUTE muss mit / beginnen.');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        throw new Error(`Die Freigabeliste ${path.basename(file)} konnte nicht gelesen werden: ${err.code || err.message}`);
      }
      let document;
      try {
        document = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`Die Freigabeliste ${path.basename(file)} ist kein gültiges JSON: ${err.message}`);
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('Die Freigabeliste hat nicht die erwartete Form { default, routes }.');
      }
      if (document.routes !== undefined && !Array.isArray(document.routes)) throw new Error('"routes" der Freigabeliste ist keine Liste.');
      const routes = Array.isArray(document.routes) ? document.routes : [];

      const previous = new Set(emailsOf(state.synced));
      const sameRoute = !state.route || state.route === route;
      let entry = routes.find((item) => item && typeof item === 'object' && item.path === route);
      const rawList = Array.isArray(entry?.extra_emails) ? entry.extra_emails : [];

      const domains = access.internalDomains(env);
      const desired = teams()
        .activeMemberEmails()
        .filter((email) => !(domains.length && domains.includes(email.slice(email.indexOf('@') + 1))));
      const desiredSet = new Set(desired);

      // Entries this module put there earlier are ours; everything else (also things that are no address, such as a
      // domain pattern of the login) is manual and stays exactly as it is.
      const isOurs = (raw) => {
        const email = access.normalizeEmail(raw);
        return Boolean(email && sameRoute && previous.has(email));
      };
      const manualSet = new Set(rawList.filter((raw) => !isOurs(raw)).map(access.normalizeEmail).filter(Boolean));
      const next = rawList.filter((raw) => !isOurs(raw) || desiredSet.has(access.normalizeEmail(raw)));
      const present = new Set(next.map(access.normalizeEmail).filter(Boolean));
      for (const email of desired) {
        if (!present.has(email)) {
          next.push(email);
          present.add(email);
        }
      }
      const synced = desired.filter((email) => !manualSet.has(email));

      // The route of an earlier run: what this module entered there is taken out again.
      let oldRouteChanged = false;
      if (state.route && state.route !== route) {
        const old = routes.find((item) => item && typeof item === 'object' && item.path === state.route);
        if (old && Array.isArray(old.extra_emails)) {
          const kept = old.extra_emails.filter((value) => !previous.has(access.normalizeEmail(value)));
          if (kept.length !== old.extra_emails.length) {
            old.extra_emails = kept;
            oldRouteChanged = true;
          }
        }
      }

      const unchanged = Boolean(entry) && rawList.length === next.length && rawList.every((value, index) => value === next[index]);
      const changed = !unchanged || oldRouteChanged;

      let backup = state.backup && state.backup.source === file ? state.backup : null;
      if (changed) {
        if (!entry) {
          entry = { path: route, public: false, extra_emails: [] };
          routes.push(entry);
        }
        entry.extra_emails = next;
        document.routes = routes;
        // The record first: whatever happens to the list afterwards, what this module entered stays known as its own.
        writeState({
          version: 1,
          route: state.route || route,
          synced: (sameRoute ? [...new Set([...previous, ...synced])] : [...previous]).sort(),
          backup: state.backup || null,
          lastRunAt: startedAt,
          lastOk: state.lastOk ?? null,
          lastError: state.lastError || null,
          lastChangeAt: state.lastChangeAt || null
        });
        if (!backup) {
          const base = `${file}.bak-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
          let copy = base;
          for (let attempt = 1; ; attempt += 1) {
            try {
              fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
              break;
            } catch (err) {
              // Never overwrite an earlier backup; a second one in the same millisecond gets a suffix.
              if (err.code !== 'EEXIST' || attempt >= 20) throw err;
              copy = `${base}-${attempt}`;
            }
          }
          backup = { source: file, path: copy, at: startedAt };
        }
        writeAtomic(file, `${JSON.stringify(document, null, 2)}\n`, stat.mode & 0o777, { uid: stat.uid, gid: stat.gid });
      }
      writeState({
        version: 1,
        route,
        synced,
        backup,
        lastRunAt: startedAt,
        lastOk: true,
        lastError: null,
        lastChangeAt: changed ? startedAt : state.lastChangeAt || null
      });
      last = { lastRunAt: startedAt, lastOk: true, lastError: null, lastChangeAt: changed ? startedAt : state.lastChangeAt || null };
      return { ok: true, enabled: true, changed, count: synced.length };
    } catch (err) {
      const message = String(err.message || err);
      console.warn('[access-sync]', message);
      last = { ...last, lastRunAt: startedAt, lastOk: false, lastError: message };
      try {
        // An unreadable record is left alone (it is what the message is about).
        if (stateRead) writeState({ ...state, lastRunAt: startedAt, lastOk: false, lastError: message });
      } catch (_) {
        /* the warning stays in memory */
      }
      return { ok: false, enabled: true, changed: false, error: message };
    }
  }

  // Runs are queued so two changes in a row never write the file at the same time.
  function sync() {
    const run = () => runOnce();
    chain = chain.then(run, run);
    return chain;
  }

  function settled() {
    return chain;
  }

  // For the admin UI: { enabled, route, ok, warning, lastRunAt, lastChangeAt, syncedCount }
  function status() {
    const { route } = settings();
    if (!enabled()) return { enabled: false };
    const state = readState();
    const lastOk = last.lastOk === null ? state.lastOk ?? null : last.lastOk;
    const error = last.lastOk === null ? state.lastError || null : last.lastError;
    return {
      enabled: true,
      route,
      ok: lastOk !== false,
      warning: lastOk === false ? error : null,
      lastRunAt: last.lastRunAt || state.lastRunAt || null,
      lastChangeAt: last.lastChangeAt || state.lastChangeAt || null,
      syncedCount: emailsOf(state.synced).length
    };
  }

  return { enabled, sync, settled, status, runOnce };
}

const defaultSync = createAccessSync();

module.exports = {
  STATE_FILE,
  createAccessSync,
  defaultSync,
  enabled: defaultSync.enabled,
  sync: defaultSync.sync,
  settled: defaultSync.settled,
  status: defaultSync.status
};
