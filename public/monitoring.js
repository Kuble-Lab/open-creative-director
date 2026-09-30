'use strict';

// Usage and monitoring page for superadmins (views/monitoring.html, data: GET api/admin/monitoring).
// All values from the server are written as text, never as HTML.
(() => {
  const el = (id) => document.getElementById(id);
  const T = (key, vars) => window.t(`monitor.${key}`, vars);
  const COST_TYPES = { brain: 'costs.brain', image: 'costs.images', video: 'costs.videos', motion: 'costs.motion', higgsfield: 'costs.higgsfield' };

  let report = null;
  let request = null;
  let busy = false;

  const lang = () => window.getLang();
  const number = (value) => new Intl.NumberFormat(lang()).format(value);
  const usd = (value) =>
    value === null || value === undefined
      ? T('unknown')
      : new Intl.NumberFormat(lang(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
  const stamp = (value) => {
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return '';
    return new Intl.DateTimeFormat(lang(), { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(time);
  };
  const tokenCount = (value) => (value === null || value === undefined ? T('unknown') : number(value));

  function node(tag, content, className) {
    const item = document.createElement(tag);
    if (content !== undefined && content !== null) item.textContent = content;
    if (className) item.className = className;
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
    section.append(node('h3', title));
    if (!rows.length) {
      section.append(node('p', T('noData'), 'mon-muted'));
      return section;
    }
    const wrap = node('div', '', 'mon-table-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', title);
    const grid = node('table', '');
    const head = node('thead', '');
    const headRow = node('tr', '');
    headings.forEach((heading, index) => {
      const cell = node('th', heading, numeric.includes(index) ? 'number' : '');
      cell.scope = 'col';
      headRow.append(cell);
    });
    head.append(headRow);
    grid.append(head);
    const body = node('tbody', '');
    for (const row of rows) {
      const line = node('tr', '');
      row.forEach((cell, index) => line.append(node('td', cell, numeric.includes(index) ? 'number' : '')));
      body.append(line);
    }
    grid.append(body);
    wrap.append(grid);
    section.append(wrap);
    return section;
  }

  function fillSelect(id, values, allLabel) {
    const control = el(id);
    const selected = control.value;
    control.replaceChildren(new Option(allLabel, ''), ...values.map((value) => new Option(value || T('unknown'), value)));
    if (selected && !values.includes(selected)) control.add(new Option(selected, selected));
    control.value = selected;
  }

  const costOf = (row) => {
    if (row.count && row.subscriptionCount === row.count) return T('subscription');
    if (row.count && row.unknownCost === row.count) return T('unknown');
    return usd(row.costUsd);
  };
  const tokensOf = (row, key) => (row[`${key}Reported`] ? number(row[`${key}Tokens`]) : '—');

  function breakdown(title, keyLabel, rows, labelOf) {
    return table(
      title,
      [keyLabel, T('colCount'), T('colCost'), T('colInput'), T('colOutput')],
      rows.map((row) => [labelOf(row.key), number(row.count), costOf(row), tokensOf(row, 'input'), tokensOf(row, 'output')]),
      [1, 2, 3, 4]
    );
  }

  function render() {
    if (!report) return;
    const data = report;
    const totals = data.totals;
    fillSelect('user', data.options.users, T('allUsers'));
    fillSelect('provider', data.options.providers, T('allProviders'));

    el('metrics').replaceChildren(
      metric(T('knownCost'), usd(totals.costUsd)),
      metric(T('calls'), number(totals.count)),
      metric(T('tokens'), totals.totalReported ? number(totals.totalTokens) : '—'),
      metric(T('runs'), number(totals.runs), totals.failedRuns ? T('failedOf', { failed: number(totals.failedRuns) }) : ''),
      metric(T('jobs'), number(totals.jobs), totals.failedJobs ? T('failedOf', { failed: number(totals.failedJobs) }) : ''),
      metric(T('apiErrors'), number(totals.apiErrors))
    );
    el('coverage').textContent = T('coverage', {
      known: number(totals.count - totals.unknownCost),
      total: number(totals.count),
      unknown: number(totals.unknownCost),
      abo: number(totals.subscriptionCount)
    });

    el('breakdowns').replaceChildren(
      breakdown(T('byUser'), T('colUser'), data.byUser, (key) => key || T('unknown')),
      breakdown(T('byProvider'), T('colProvider'), data.byProvider, (key) => key || T('unknown')),
      breakdown(T('byDay'), T('colDay'), data.byDay, (key) => key),
      breakdown(T('byType'), T('colType'), data.byType, (key) => (COST_TYPES[key] ? window.t(COST_TYPES[key]) : key || T('unknown')))
    );

    el('operations').replaceChildren(
      table(
        T('entries'),
        [T('colTime'), T('colUser'), T('colProvider'), T('colModel'), T('colSession'), T('colBilling'), T('colCost'), T('colInput'), T('colOutput'), T('colTotal')],
        data.rows.map((row) => [
          stamp(row.ts),
          row.user,
          row.provider,
          row.model,
          row.sessionId,
          row.billing === 'Abo' ? T('subscription') : row.billing || '—',
          row.billing === 'Abo' ? T('subscription') : usd(row.costUsd),
          tokenCount(row.tokens.input),
          tokenCount(row.tokens.output),
          tokenCount(row.tokens.total)
        ]),
        [6, 7, 8, 9]
      )
    );

    const errorsBlock = node('div', '');
    errorsBlock.append(
      node('h2', T('errors')),
      table(
        T('runErrors'),
        [T('colTime'), T('colUser'), T('colWorkflow'), T('colRun'), T('colStatus'), T('colError')],
        data.runs.errors.map((row) => [stamp(row.ts), row.user, row.workflowId, row.runId, row.status, row.error || '—'])
      ),
      table(
        T('jobErrors'),
        [T('colTime'), T('colUser'), T('colProvider'), T('colSession'), T('colJob'), T('colError')],
        data.jobs.errors.map((row) => [stamp(row.ts), row.user, row.provider, row.sessionId, row.jobId, row.error || '—'])
      ),
      table(
        T('requestErrors'),
        [T('colTime'), T('colUser'), T('colRoute'), T('colCode'), T('colDuration')],
        data.errors.rows.map((row) => [stamp(row.ts), row.user, `${row.method} ${row.route}`, row.code, `${number(row.durationMs)} ms`]),
        [4]
      ),
      table(
        T('deniedRequests'),
        [T('colTime'), T('colUser'), T('colRoute'), T('colCode')],
        (data.errors.deniedRows || []).map((row) => [stamp(row.ts), row.user, `${row.method} ${row.route}`, row.code])
      )
    );
    el('errors').replaceChildren(errorsBlock);

    const runtime = data.runtime || {};
    el('runtime').replaceChildren(
      metric(T('started'), runtime.startedAt ? stamp(runtime.startedAt) : '—'),
      metric(T('uptime'), T('minutes', { n: number(Math.floor((runtime.uptimeSeconds || 0) / 60)) })),
      metric(T('requests'), number(runtime.requests || 0)),
      metric(T('apiErrors'), number(runtime.failedRequests || 0)),
      metric(T('memory'), `${number(runtime.memoryMb || 0)} MB`),
      metric(T('journal'), T(runtime.journalWritable === false ? 'journalError' : 'journalOk'))
    );

    el('updated').textContent = T('updated', { time: stamp(data.generatedAt) });
    el('report').hidden = false;
    el('status').className = 'mon-status';
    el('status').textContent = totals.count ? '' : T('noData');
  }

  function query() {
    return new URLSearchParams({ days: el('days').value, user: el('user').value, provider: el('provider').value }).toString();
  }

  async function load() {
    if (request) request.abort();
    const current = new AbortController();
    request = current;
    busy = true;
    el('refresh').disabled = true;
    el('export').disabled = true;
    el('status').className = 'mon-status';
    el('status').textContent = T('loading');
    try {
      const response = await fetch(`api/admin/monitoring?${query()}`, { signal: current.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 404 ? 'denied' : 'loadError');
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('loadError');
      report = await response.json();
      render();
      el('export').disabled = false;
    } catch (error) {
      if (error.name === 'AbortError') return;
      report = null;
      el('updated').textContent = '';
      el('report').hidden = true;
      el('status').className = 'mon-status error';
      el('status').textContent = T(error.message === 'denied' ? 'denied' : 'loadError');
    } finally {
      if (request === current) {
        busy = false;
        el('refresh').disabled = false;
      }
    }
  }

  el('filters').addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  for (const id of ['days', 'user', 'provider']) el(id).addEventListener('change', load);

  el('export').addEventListener('click', async () => {
    el('export').disabled = true;
    try {
      const response = await fetch(`api/admin/monitoring/export?${query()}`, { cache: 'no-store' });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('text/csv')) throw new Error('export');
      const url = URL.createObjectURL(await response.blob());
      const link = node('a', '');
      link.href = url;
      link.download = 'usage-monitoring.csv';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      el('status').className = 'mon-status';
      el('status').textContent = T('downloaded');
    } catch (_) {
      el('status').className = 'mon-status error';
      el('status').textContent = T('exportError');
    } finally {
      el('export').disabled = busy;
    }
  });

  for (const button of document.querySelectorAll('#langSwitch button')) {
    button.addEventListener('click', () => window.setLang(button.dataset.lang));
  }
  window.onLangChange = () => {
    document.title = T('title');
    if (report) render();
  };
  document.title = T('title');

  setInterval(() => {
    if (el('auto').checked && !document.hidden && !busy) load();
  }, 60000);
  load();
})();
