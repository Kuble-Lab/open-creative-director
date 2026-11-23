'use strict';

// Superadmin activity, using the shared contract of GET api/admin/activity.
(() => {
  const el = (id) => document.getElementById(id);
  const T = (key, vars) => window.t(`activity.${key}`, vars);
  const lang = () => window.getLang();
  const known = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value) => known(value) ? new Intl.NumberFormat(lang(), { maximumFractionDigits: 2 }).format(value) : T('unknown');
  const usd = (value) => known(value) ? new Intl.NumberFormat(lang(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : T('unknown');
  const pct = (value) => known(value) ? `${number(value)} %` : T('unknown');
  const stamp = (value) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(lang(), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(value)) : T('unknown');
  const REASONS = { USERS_ABOVE_TESTED: 'reasonUsers', LOAD_HIGH: 'reasonLoad', MEMORY_LOW: 'reasonMemory', DISK_LOW: 'reasonDisk', EVENT_LOOP_LAG: 'reasonLag' };
  const STATES = { ok: 'stateOk', near: 'stateNear', due: 'stateDue', blocked: 'stateBlocked' };
  const STATUSES = { running: 'running', waiting_approval: 'waitingApproval', pending: 'pending', queued: 'queued', waiting: 'waiting', processing: 'processing', submitted: 'submitted', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
  const STRIKE_CODES = { IMAGE_SAFETY_EXHAUSTED: 'filterImage', GEMINI_IMAGE_BLOCKED: 'filterImage', PLANNER_CONTENT_FILTER: 'filterText', CONTENT_FILTER: 'filterContent', VIDEO_CONTENT_FILTER: 'filterVideo', VIDEO_SAFETY: 'filterVideo' };
  const confirmations = new Map();
  const buttons = new Map();
  const pending = new Set();
  let report = null;
  let request = null;
  let timer = null;
  let reloadRequested = false;
  let statusKey = 'loading';
  let actionKey = '';

  function node(tag, content, className) {
    const item = document.createElement(tag);
    if (content !== undefined && content !== null) item.textContent = content;
    if (className) item.className = className;
    return item;
  }

  function relative(value) {
    const item = node('time', T('unknown'));
    if (!value || !Number.isFinite(Date.parse(value))) return item;
    item.dateTime = value;
    item.title = stamp(value);
    const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
    const [unit, scale] = Math.abs(seconds) < 60 ? ['second', 1] : Math.abs(seconds) < 3600 ? ['minute', 60] : Math.abs(seconds) < 86400 ? ['hour', 3600] : ['day', 86400];
    item.textContent = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto', style: 'short' }).format(Math.round(seconds / scale), unit);
    return item;
  }

  function metric(label, value, hint) {
    const item = node('div', '', 'mon-metric');
    item.append(node('dt', label), node('dd', value));
    if (hint) item.append(node('small', hint, 'mon-muted'));
    return item;
  }

  function table(title, headings, rows, numeric = []) {
    const section = node('div', '', 'mon-table-block');
    if (title) section.append(node('h2', title));
    if (!rows.length) {
      section.append(node('p', T('noData'), 'mon-muted'));
      return section;
    }
    const wrap = node('div', '', 'mon-table-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', title || T('strikes'));
    const grid = node('table');
    const head = node('thead');
    const heading = node('tr');
    headings.forEach((text, index) => {
      const cell = node('th', text, numeric.includes(index) ? 'number' : '');
      cell.scope = 'col';
      heading.append(cell);
    });
    head.append(heading);
    const body = node('tbody');
    rows.forEach((row) => {
      const line = node('tr');
      row.forEach((value, index) => {
        const cell = node('td', '', numeric.includes(index) ? 'number' : '');
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value === null || value === undefined ? T('unknown') : String(value);
        line.append(cell);
      });
      body.append(line);
    });
    grid.append(head, body);
    wrap.append(grid);
    section.append(wrap);
    return section;
  }

  function svgNode(tag, attributes = {}, text) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => item.setAttribute(key, String(value)));
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function duration(seconds) {
    if (seconds >= 172800) return T('days', { count: number(Math.floor(seconds / 86400)) });
    if (seconds >= 7200) return T('hours', { count: number(Math.floor(seconds / 3600)) });
    return T('minutes', { count: number(Math.floor(seconds / 60)) });
  }

  function renderHistory() {
    const samples = (report.history || []).filter((sample) => Number.isFinite(Date.parse(sample.ts)));
    if (!samples.length) {
      el('history').replaceChildren(node('p', T('noSamples'), 'mon-muted'));
      return;
    }
    const end = Math.max(Date.parse(report.generatedAt) || Date.now(), ...samples.map((sample) => Date.parse(sample.ts)));
    const start = end - 86400000;
    const visible = samples.filter((sample) => Date.parse(sample.ts) >= start);
    // A phone gets its own drawing width, so labels keep their size instead of shrinking with a wide drawing.
    const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 480px)').matches;
    const width = narrow ? 420 : 1000;
    const left = narrow ? 24 : 45;
    const right = width - (narrow ? 10 : 55);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} 180`, role: 'img', 'aria-label': T('chartLabel'), class: 'activity-chart' });
    svg.append(svgNode('title', {}, T('chartLabel')));
    svg.append(svgNode('line', { x1: left, y1: 144, x2: right, y2: 144, class: 'activity-axis' }));
    const legend = node('div', '', 'activity-legend');
    for (const [key, label, className] of [['online', 'onlineNow', 'activity-series-online'], ['loadPerCpu', 'loadPerCpu', 'activity-series-load']]) {
      const max = Math.max(1, ...visible.map((sample) => known(sample[key]) ? sample[key] : 0));
      legend.append(node('span', T('seriesScale', { label: T(label), max: number(max) }), className));
      let points = [];
      const flush = () => {
        if (points.length > 1) svg.append(svgNode('polyline', { points: points.join(' '), class: className }));
        if (points.length === 1) {
          const [cx, cy] = points[0].split(',');
          svg.append(svgNode('circle', { cx, cy, r: 3, class: className }));
        }
        points = [];
      };
      for (const sample of visible) {
        if (!known(sample[key])) { flush(); continue; }
        const x = left + (Date.parse(sample.ts) - start) / 86400000 * (right - left);
        const y = 144 - Math.max(0, sample[key]) / max * 125;
        points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
      flush();
    }
    svg.append(svgNode('text', { x: left, y: 170, class: 'activity-axis-label' }, stamp(new Date(start).toISOString())));
    svg.append(svgNode('text', { x: right, y: 170, 'text-anchor': 'end', class: 'activity-axis-label' }, stamp(new Date(end).toISOString())));
    svg.append(svgNode('text', { x: left - 13, y: 148, class: 'activity-axis-label' }, '0'));
    el('history').replaceChildren(legend, svg);
  }

  function updateButton(email) {
    const button = buttons.get(email);
    const user = report?.strikes.users.find((entry) => entry.email === email);
    if (!button || !user) return;
    const action = user.blocked ? 'unblock' : 'block';
    const confirmation = confirmations.get(email);
    const armed = confirmation && confirmation.action === action && confirmation.until > Date.now();
    button.disabled = pending.has(email);
    button.textContent = T(pending.has(email) ? 'saving' : armed ? (action === 'block' ? 'confirmBlock' : 'confirmUnblock') : action);
    button.setAttribute('aria-label', `${button.textContent} · ${email}`);
    button.classList.toggle('activity-confirm', Boolean(armed));
  }

  async function changeBlock(email) {
    const user = report?.strikes.users.find((entry) => entry.email === email);
    if (!user || !user.blockable || pending.has(email)) return;
    const action = user.blocked ? 'unblock' : 'block';
    const confirmation = confirmations.get(email);
    if (!confirmation || confirmation.action !== action || confirmation.until <= Date.now()) {
      if (confirmation) clearTimeout(confirmation.timer);
      const next = { action, until: Date.now() + 6000 };
      next.timer = setTimeout(() => {
        if (confirmations.get(email) === next) { confirmations.delete(email); updateButton(email); }
      }, 6000);
      confirmations.set(email, next);
      updateButton(email);
      return;
    }
    clearTimeout(confirmation.timer);
    confirmations.delete(email);
    pending.add(email);
    request?.abort();
    updateButton(email);
    actionKey = '';
    el('actionStatus').textContent = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`api/admin/activity/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }), cache: 'no-store', signal: controller.signal
      });
      const payload = await response.json();
      if (!response.ok || payload.ok !== true) {
        actionKey = payload.code === 'CANNOT_BLOCK_ADMIN' ? 'cannotBlockAdmin' : payload.code === 'INVALID_EMAIL' ? 'invalidEmail' : response.status === 404 ? 'unavailable' : 'actionError';
        throw new Error('action');
      }
      actionKey = action === 'block' ? 'blockedSuccess' : 'unblockedSuccess';
      el('actionStatus').className = 'mon-status';
    } catch (_) {
      actionKey = actionKey || 'actionError';
      el('actionStatus').className = 'mon-status error';
    } finally {
      clearTimeout(timeout);
      pending.delete(email);
      updateButton(email);
      el('actionStatus').textContent = T(actionKey);
      if (request) reloadRequested = true;
      else load();
    }
  }

  function renderStrikes() {
    const strikes = report.strikes;
    const focused = document.activeElement?.dataset.activityEmail;
    const present = new Set();
    const rows = strikes.users.map((user) => {
      present.add(user.email);
      const state = user.blocked ? 'blocked' : Object.hasOwn(STATES, user.state) ? user.state : 'ok';
      const badge = node('span', T(STATES[state]), `activity-badge activity-state-${state}`);
      const stateCell = node('div');
      stateCell.append(badge);
      if (user.admin) stateCell.append(node('small', T('admin'), 'activity-admin mon-muted'));
      let control = '—';
      if (user.blockable) {
        if (!buttons.has(user.email)) {
          const button = node('button');
          button.type = 'button';
          button.dataset.activityEmail = user.email;
          button.addEventListener('click', () => changeBlock(user.email));
          buttons.set(user.email, button);
        }
        updateButton(user.email);
        control = buttons.get(user.email);
      }
      return [user.email, stateCell, T('strikeCount', { count: number(user.count), limit: number(strikes.limit) }), number(user.total), relative(user.lastTs), control];
    });
    el('strikeUsers').replaceChildren(table('', [T('person'), T('state'), T('inWindow'), T('total'), T('lastStrike'), T('action')], rows, [2, 3]));
    for (const [email, button] of buttons) {
      if (!present.has(email) || !strikes.users.find((user) => user.email === email)?.blockable) {
        button.remove();
        buttons.delete(email);
        clearTimeout(confirmations.get(email)?.timer);
        confirmations.delete(email);
      }
    }
    if (focused) buttons.get(focused)?.focus({ preventScroll: true });
    el('strikePolicy').textContent = T('policy', { days: number(strikes.windowDays), limit: number(strikes.limit), auto: T(strikes.autoBlock ? 'enabled' : 'disabled') });
    el('recentStrikes').replaceChildren(table(T('recentStrikes'), [T('time'), T('person'), T('source'), T('code'), T('providerModel')], strikes.recent.map((strike) => [
      relative(strike.ts), strike.user, T(strike.source === 'run' ? 'run' : 'job'),
      `${T(Object.hasOwn(STRIKE_CODES, strike.code) ? STRIKE_CODES[strike.code] : 'filterContent')} (${strike.code})`,
      [strike.provider, strike.model].filter(Boolean).join(' · ') || T('unknown')
    ])));
  }

  function render() {
    if (!report) return;
    const { capacity, system, costs, peaks, renderQueue } = report;
    const verdict = ['ok', 'watch', 'upgrade'].includes(capacity.verdict) ? capacity.verdict : 'watch';
    el('capacity').className = `activity-capacity activity-capacity-${verdict}`;
    el('capacityVerdict').textContent = T({ ok: 'capacityOk', watch: 'capacityWatch', upgrade: 'capacityUpgrade' }[verdict]);
    el('capacityReasons').replaceChildren(...capacity.reasons.map((reason) => node('li', T(Object.hasOwn(REASONS, reason.code) ? REASONS[reason.code] : 'reasonUnknown', { code: reason.code, value: number(reason.value), limit: number(reason.limit) }))));
    el('capacityRule').textContent = T('capacityRule', { testedUsers: number(capacity.testedUsers) });
    el('metrics').replaceChildren(
      metric(T('onlineNow'), number(report.online.length)), metric(T('peakDay'), number(peaks.h24.online)),
      metric(T('runs'), number(report.runs.length)), metric(T('jobs'), number(report.jobs.length)),
      metric(T('costToday'), usd(costs.todayUsd), costs.unknownToday ? T('unknownCosts', { count: number(costs.unknownToday) }) : ''),
      metric(T('costHour'), usd(costs.lastHourUsd)), metric(T('load'), number(system.load1), T('perCpu', { value: number(system.loadPerCpu15) })),
      metric(T('memory'), pct(system.memUsedPct)), metric(T('disk'), pct(system.diskFreePct))
    );
    el('runtime').replaceChildren(
      metric(T('renderQueue'), T('queueCounts', { waiting: number(renderQueue.waiting), running: number(renderQueue.running) })),
      metric(T('peakWeek'), number(peaks.d7.online)),
      metric(T('uptime'), known(system.uptimeSeconds) ? duration(system.uptimeSeconds) : T('unknown'))
    );
    renderHistory();
    el('online').replaceChildren(table(T('onlineNow'), [T('email'), T('teams'), T('lastActive'), T('requests'), T('runs')], report.online.map((person) => [person.email, person.teams.join(', ') || '—', relative(person.lastSeen), number(person.requests5m), number(person.runsRunning)]), [3, 4]));
    const status = (value) => Object.hasOwn(STATUSES, value) ? T(STATUSES[value]) : value || T('unknown');
    el('operations').replaceChildren(table(T('operations'), [T('kind'), T('titleOrProvider'), T('person'), T('since'), T('state')], [
      ...report.runs.map((run) => [T('run'), run.title || run.workflowId, run.user, relative(run.startedAt), status(run.status)]),
      ...report.jobs.map((job) => [T('job'), [job.provider, job.kind].filter(Boolean).join(' · '), job.user, relative(job.ts), status(job.status)])
    ]));
    el('topCosts').replaceChildren(table(T('topCosts'), [T('person'), T('cost'), T('count')], costs.topToday.map((person) => [person.user, usd(person.costUsd), number(person.count)]), [1, 2]));
    renderStrikes();
    el('updated').textContent = T('updated', { time: stamp(report.generatedAt) });
    el('report').hidden = false;
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(load, 10000);
  }

  async function load() {
    if (document.hidden || pending.size) return;
    if (request) { reloadRequested = true; return; }
    clearTimeout(timer);
    const current = new AbortController();
    request = current;
    const timeout = setTimeout(() => current.abort(), 15000);
    try {
      const response = await fetch('api/admin/activity', { cache: 'no-store', signal: current.signal });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'unavailable' : 'loadError');
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('loadError');
      const data = await response.json();
      // A hide or write may abort after the body has already arrived.
      if (current.signal.aborted || document.hidden) return;
      report = data;
      render();
      statusKey = '';
      el('status').className = 'mon-status';
    } catch (error) {
      if (current.signal.aborted && (document.hidden || pending.size || reloadRequested)) return;
      statusKey = error.message === 'unavailable' ? 'unavailable' : 'loadError';
      if (statusKey === 'unavailable') {
        report = null;
        el('report').hidden = true;
        el('updated').textContent = '';
      }
      el('status').className = 'mon-status error';
    } finally {
      clearTimeout(timeout);
      request = null;
      el('status').textContent = statusKey ? T(statusKey) : '';
      if (reloadRequested && !document.hidden && !pending.size) {
        reloadRequested = false;
        load();
      } else schedule();
    }
  }

  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) request?.abort();
    else load();
  });
  for (const button of document.querySelectorAll('#langSwitch button')) {
    button.addEventListener('click', () => window.setLang(button.dataset.lang));
  }
  window.onLangChange = () => {
    document.title = T('title');
    render();
    el('status').textContent = statusKey ? T(statusKey) : '';
    el('actionStatus').textContent = actionKey ? T(actionKey) : '';
  };
  document.title = T('title');
  el('status').textContent = T('loading');
  load();
})();
