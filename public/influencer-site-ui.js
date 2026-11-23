'use strict';

// The page of an AI influencer on the website host (lib/influencer-pages.js, /api/influencers/:id/site; the connection of the installation:
// lib/rtk-host.js, /api/website-host). Three parts, all of them stay out while the server has no host address:
//
//   OCInfluencerSite.mount(container, influencer)   the block "Seite" in the edit view of the window "Influencer"
//   OCInfluencerSite.reset()                        the edit view closed: stop reading the state of a run
//   OCInfluencerSite.addButton({ sessionId, assetId, kind, className, icon })
//                                                   the action "Auf die Seite von ..." of a result (chat card, Design App); it adds the
//                                                   piece to the draft of the page and never publishes
//   OCInfluencerSite.refreshHost()                  the section "Website-Host" of the settings (admins connect and disconnect)
//
// Loaded after the chat scripts; it uses their helpers (api, rel, t, setStatus, managerAction, formatDate). Everything from the server is
// written as text; there are no native dialogs.

(function initInfluencerSite(global) {
  const POLL_MS = 2000;
  const enc = encodeURIComponent;
  const base = (id) => `/api/influencers/${enc(id)}/site`;
  // what the block shows: `data` is the server's answer, `draft` what the person typed and has not saved yet
  const site = { id: null, name: '', container: null, data: null, draft: null, loading: false, error: '', note: '', busy: false,
    confirm: false, pendingRemove: null, slug: null, timer: null, watched: false };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const lines = (value) => String(value || '').split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);

  /* ---------- the block "Seite" ---------- */

  function draftOf(data) {
    const s = data.site;
    return { slug: s.slug || data.slugSuggestion || '', visibility: s.visibility, emails: (s.allowedEmails || []).join('\n'),
      domains: (s.allowedDomains || []).join('\n'), lang: s.lang, about: s.about || '', usage: s.usage,
      items: s.items.map((item) => ({ id: item.id, title: item.title || '', description: item.description || '' })) };
  }

  function take(data, { keepDraft = false } = {}) {
    const old = keepDraft && site.draft ? site.draft : null;
    site.data = data;
    if (!data.site) { site.draft = null; return; }
    const fresh = draftOf(data);
    if (old) {
      // keep what was typed; pieces follow the server (a removed one is gone, a new one comes in front)
      const texts = new Map(old.items.map((item) => [item.id, item]));
      const order = old.items.map((item) => item.id).filter((id) => fresh.items.some((item) => item.id === id));
      const rest = fresh.items.filter((item) => !order.includes(item.id));
      fresh.items = [...rest, ...order.map((id) => texts.get(id))];
      site.draft = { ...old, items: fresh.items, ...(data.published ? { slug: fresh.slug } : {}) };
    } else site.draft = fresh;
  }

  const showing = (id) => site.id === id && site.container && site.container.isConnected;

  function stopPolling() {
    if (site.timer) clearTimeout(site.timer);
    site.timer = null;
  }

  function reset() {
    stopPolling();
    Object.assign(site, { id: null, name: '', container: null, data: null, draft: null, loading: false, error: '', note: '', busy: false,
      confirm: false, pendingRemove: null, slug: null, watched: false });
  }

  function mount(container, influencer) {
    if (site.id !== influencer.id) reset();
    site.id = influencer.id;
    site.name = influencer.name;
    site.container = container;
    render();
    if (!site.data && !site.loading) load();
    else if (site.data && site.data.job && site.data.job.state === 'running') poll();
  }

  async function load() {
    const id = site.id;
    site.loading = true;
    site.error = '';
    try {
      const data = await api(base(id));
      if (!showing(id)) return;
      take(data);
      if (data.job && data.job.state === 'running') { site.watched = true; poll(); }
    } catch (err) {
      if (showing(id)) site.error = err.message;
    } finally {
      if (site.id === id) site.loading = false;
      if (showing(id)) render();
    }
  }

  function poll() {
    stopPolling();
    const id = site.id;
    site.timer = setTimeout(async () => {
      site.timer = null;
      if (!showing(id)) return;
      try {
        const data = await api(base(id));
        if (!showing(id)) return;
        const running = data.job && data.job.state === 'running';
        take(data, { keepDraft: running });
        if (running) poll();
        else if (site.watched) {
          site.watched = false;
          // a run with problems shows them (lastError and the list per piece) instead of the success note
          const clean = Boolean(data.site && !data.site.lastError);
          site.note = clean ? t('influencers.site.publishedNote') : '';
          if (clean) setStatus(t('influencers.site.publishedNote'));
        }
        render();
      } catch (_) {
        if (showing(id)) poll();
      }
    }, POLL_MS);
  }

  function patchBody() {
    const d = site.draft;
    const body = { visibility: d.visibility, allowedEmails: lines(d.emails), allowedDomains: lines(d.domains), lang: d.lang, about: d.about,
      usage: d.usage, items: d.items.map((item) => ({ id: item.id, title: item.title, description: item.description })) };
    if (!site.data.published) body.slug = d.slug.trim().toLowerCase();
    return body;
  }

  // Saves the draft; false (with the message shown) when the server refuses it.
  async function save({ quiet = false } = {}) {
    const id = site.id;
    site.error = '';
    try {
      const data = await api(base(id), { method: 'PATCH', body: JSON.stringify(patchBody()) });
      if (!showing(id)) return false;
      take(data);
      if (!quiet) { site.note = t('influencers.site.saved'); render(); }
      return true;
    } catch (err) {
      if (showing(id)) { site.error = err.message; site.note = ''; render(); }
      return false;
    }
  }

  async function run(action) {
    if (site.busy) return;
    site.busy = true;
    site.note = '';
    render();
    try { await action(); } finally { site.busy = false; if (site.container && site.container.isConnected) render(); }
  }

  async function publish(confirmPublic) {
    const id = site.id;
    if (!(await save({ quiet: true }))) return;
    const s = site.data.site;
    const becomesPublic = s.visibility === 'public' && (!site.data.published || s.publishedVisibility !== 'public');
    if (becomesPublic && !confirmPublic) { site.confirm = true; return; }
    site.confirm = false;
    try {
      const answer = await api(`${base(id)}/publish`, { method: 'POST', body: JSON.stringify(confirmPublic ? { confirmPublic: true } : {}) });
      if (!showing(id)) return;
      site.data = { ...site.data, job: answer.job };
      site.watched = true;
      poll();
    } catch (err) {
      if (!showing(id)) return;
      if (err.code === 'SITE_CONFIRM_PUBLIC_REQUIRED') { site.confirm = true; return; }
      site.error = err.message;
      if (err.code === 'SITE_BUSY') { site.watched = true; poll(); }
    }
  }

  async function checkSlug() {
    const id = site.id;
    const wanted = site.draft.slug;
    try {
      const answer = await api(`${base(id)}/slug?slug=${enc(wanted)}`);
      if (!showing(id)) return;
      site.slug = answer;
      if (answer.valid && answer.slug) site.draft.slug = answer.slug;
    } catch (err) {
      if (showing(id)) site.error = err.message;
    }
  }

  async function addYoutube() {
    const id = site.id;
    try {
      const answer = await api(`${base(id)}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtube: site.youtube || '' }) });
      if (!showing(id)) return;
      site.youtube = '';
      take({ ...site.data, site: answer.site }, { keepDraft: true });
    } catch (err) {
      if (showing(id)) site.error = err.message;
    }
  }

  async function removeItem(itemId) {
    const id = site.id;
    try {
      const answer = await api(`${base(id)}/items/${enc(itemId)}`, { method: 'DELETE' });
      if (!showing(id)) return;
      site.pendingRemove = null;
      take({ ...site.data, site: answer.site }, { keepDraft: true });
    } catch (err) {
      if (showing(id)) site.error = err.message;
    }
  }

  async function connectHost() {
    try {
      const answer = await api('/api/website-host/connect', { method: 'POST', body: '{}' });
      if (answer && typeof answer.authorizationUrl === 'string' && /^https?:\/\//.test(answer.authorizationUrl)) global.location.assign(answer.authorizationUrl);
    } catch (err) {
      site.error = err.message;
      hostState.error = err.message;
      renderHost();
    }
  }

  function labelled(labelText, control, hint) {
    const wrap = element('label', 'influencer-field');
    wrap.appendChild(element('span', 'influencer-field-label', labelText));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(element('span', 'influencer-field-hint', hint));
    return wrap;
  }

  function input(tag, value, { max, rows, disabled, onInput } = {}) {
    const node = document.createElement(tag);
    if (tag === 'input') node.type = 'text';
    node.className = 'settings-input';
    node.value = value || '';
    if (max) node.maxLength = max;
    if (rows) node.rows = rows;
    node.disabled = Boolean(disabled);
    node.addEventListener('input', () => onInput(node.value));
    return node;
  }

  function select(value, options, onChange, disabled) {
    const node = element('select', 'settings-input');
    for (const [id, text] of options) {
      const option = element('option', '', text);
      option.value = id;
      node.appendChild(option);
    }
    node.value = value;
    node.disabled = Boolean(disabled);
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  function itemRow(item, index, locked) {
    const d = site.draft;
    const info = site.data.site.items.find((entry) => entry.id === item.id) || {};
    const row = element('div', 'influencer-site-item');
    const thumb = element('div', 'influencer-site-thumb');
    if (info.preview && info.kind === 'image') {
      const img = element('img');
      img.src = rel(`${base(site.id).slice(1)}/preview/${info.preview}`);
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      thumb.appendChild(element('span', '', info.kind === 'youtube' ? 'YouTube' : t(info.kind === 'video' ? 'influencers.site.kindVideo' : 'influencers.site.kindImage')));
    }
    row.appendChild(thumb);

    const texts = element('div', 'influencer-site-item-texts');
    const title = input('input', item.title, { max: 120, disabled: locked, onInput: (value) => { item.title = value; } });
    title.placeholder = t('influencers.site.itemTitle');
    title.setAttribute('aria-label', t('influencers.site.itemTitle'));
    const text = input('textarea', item.description, { max: 1200, rows: 2, disabled: locked, onInput: (value) => { item.description = value; } });
    text.placeholder = t('influencers.site.itemText');
    text.setAttribute('aria-label', t('influencers.site.itemText'));
    texts.append(title, text);
    texts.appendChild(element('span', 'influencer-field-hint', [info.date, info.kind === 'youtube' ? 'YouTube' : t(info.hosted ? 'influencers.site.itemHosted' : 'influencers.site.itemDraft')].filter(Boolean).join(' · ')));
    row.appendChild(texts);

    const actions = element('div', 'influencer-site-item-actions');
    const move = (delta) => () => {
      const target = index + delta;
      if (target < 0 || target >= d.items.length) return;
      d.items.splice(target, 0, d.items.splice(index, 1)[0]);
      render();
    };
    const up = managerAction('↑', move(-1), { disabled: locked || index === 0 });
    up.title = t('influencers.site.moveUp');
    up.setAttribute('aria-label', t('influencers.site.moveUp'));
    const down = managerAction('↓', move(1), { disabled: locked || index === d.items.length - 1 });
    down.title = t('influencers.site.moveDown');
    down.setAttribute('aria-label', t('influencers.site.moveDown'));
    const confirming = site.pendingRemove === item.id;
    const remove = managerAction(confirming ? t('influencers.site.reallyRemove') : t('influencers.site.remove'), () => {
      if (!confirming) { site.pendingRemove = item.id; render(); return; }
      run(() => removeItem(item.id));
    }, { danger: true, disabled: locked });
    actions.append(up, down, remove);
    row.appendChild(actions);
    return row;
  }

  function jobLine(job) {
    const step = t(`influencers.site.step.${job.step}`);
    return job.total ? t('influencers.site.running', { step, done: Math.min(job.done, job.total), total: job.total }) : t('influencers.site.runningPlain', { step });
  }

  function render() {
    const container = site.container;
    if (!container) return;
    container.replaceChildren();
    container.classList.remove('hidden');
    if (site.loading && !site.data) {
      container.appendChild(element('div', 'influencer-field-label', t('influencers.site.title')));
      container.appendChild(element('p', 'influencer-field-hint', t('influencers.site.loading')));
      return;
    }
    if (!site.data) {
      if (!site.error) { container.classList.add('hidden'); return; }
      container.appendChild(element('div', 'influencer-field-label', t('influencers.site.title')));
      container.appendChild(element('div', 'branding-import-feedback error', site.error));
      return;
    }
    const { host, job } = site.data;
    // No host address on this installation: the whole function stays out.
    if (!host.enabled || !site.data.site) { container.classList.add('hidden'); return; }
    const s = site.data.site;
    const d = site.draft;
    const running = Boolean(job && job.state === 'running');
    const locked = running || site.busy;
    const published = site.data.published;

    container.appendChild(element('div', 'influencer-field-label', t('influencers.site.title')));
    container.appendChild(element('p', 'influencer-field-hint', t('influencers.site.explain')));

    if (!host.connected) {
      const hint = element('div', 'influencer-site-notice');
      hint.appendChild(element('span', '', t(host.canManage ? 'influencers.site.hostMissingAdmin' : 'influencers.site.hostMissing')));
      if (host.canManage) hint.appendChild(managerAction(t('influencers.site.hostConnect'), () => run(connectHost), { disabled: site.busy }));
      container.appendChild(hint);
    } else if (!published && host.canCreate === false) {
      container.appendChild(element('div', 'influencer-site-notice', t('influencers.site.cannotCreate')));
    }
    if (published && s.url) {
      const line = element('p', 'influencer-site-live');
      line.appendChild(element('span', '', `${t('influencers.site.publishedAt', { date: formatDate(s.publishedAt) })} `));
      if (/^https:\/\//.test(s.url)) {
        const link = element('a', '', s.url.replace(/^https:\/\//, ''));
        link.href = s.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        line.appendChild(link);
      }
      line.appendChild(element('span', 'influencer-field-hint', ` · ${t(s.publishedVisibility === 'protected' ? 'influencers.site.protected' : 'influencers.site.public')}`));
      container.appendChild(line);
    }

    // the address
    const slugInput = input('input', d.slug, { max: 40, disabled: locked || published, onInput: (value) => { d.slug = value; site.slug = null; } });
    slugInput.spellcheck = false;
    const slugRow = element('div', 'influencer-site-row');
    slugRow.appendChild(slugInput);
    if (!published) slugRow.appendChild(managerAction(t('influencers.site.slugCheck'), () => run(checkSlug), { disabled: locked || !host.connected }));
    let slugHint = t(published ? 'influencers.site.slugFixed' : 'influencers.site.slugHint');
    if (!published && site.slug) {
      slugHint = !site.slug.valid ? t('influencers.site.slugInvalid')
        : site.slug.available === true ? t('influencers.site.slugFree', { slug: site.slug.slug })
          : site.slug.available === false ? t('influencers.site.slugTaken', { slug: site.slug.slug }) : t('influencers.site.slugUnknown');
    }
    container.appendChild(labelled(t('influencers.site.slug'), slugRow, slugHint));

    // who may see it
    container.appendChild(labelled(t('influencers.site.visibility'), select(d.visibility, [
      ['public', t('influencers.site.public')], ['protected', t('influencers.site.protected')]
    ], (value) => { d.visibility = value; site.confirm = false; render(); }, locked),
    t(d.visibility === 'public' ? 'influencers.site.publicHint' : 'influencers.site.protectedHint')));
    if (d.visibility === 'protected') {
      container.appendChild(labelled(t('influencers.site.emails'), input('textarea', d.emails, { rows: 2, disabled: locked, onInput: (value) => { d.emails = value; } }), t('influencers.site.emailsHint')));
      container.appendChild(labelled(t('influencers.site.domains'), input('textarea', d.domains, { rows: 2, disabled: locked, onInput: (value) => { d.domains = value; } }), t('influencers.site.domainsHint')));
    }

    container.appendChild(labelled(t('influencers.site.lang'), select(d.lang, [['de', 'Deutsch'], ['en', 'English'], ['es', 'Español']], (value) => { d.lang = value; }, locked)));
    container.appendChild(labelled(t('influencers.site.about'), input('textarea', d.about, { max: 2000, rows: 4, disabled: locked, onInput: (value) => { d.about = value; } }), t('influencers.site.aboutHint')));
    container.appendChild(labelled(t('influencers.site.usage'), select(d.usage, [
      ['closed', t('influencers.site.usageClosed')], ['open', t('influencers.site.usageOpen')]
    ], (value) => { d.usage = value; }, locked)));

    // the pieces
    container.appendChild(element('div', 'influencer-field-label', t('influencers.site.items', { n: d.items.length, max: site.data.maxItems || 60 })));
    if (!d.items.length) container.appendChild(element('p', 'influencer-field-hint', t('influencers.site.itemsEmpty', { name: site.name })));
    else {
      const list = element('div', 'influencer-site-items');
      d.items.forEach((item, index) => list.appendChild(itemRow(item, index, locked)));
      container.appendChild(list);
    }
    // a film that is already on YouTube comes in by its link
    const tubeRow = element('div', 'influencer-site-row');
    const tube = input('input', site.youtube, { max: 200, disabled: locked, onInput: (value) => { site.youtube = value; } });
    tube.placeholder = t('influencers.site.youtubeLink');
    tube.setAttribute('aria-label', t('influencers.site.youtubeLink'));
    tubeRow.append(tube, managerAction(t('influencers.site.youtubeAdd'), () => run(addYoutube), { disabled: locked }));
    container.appendChild(tubeRow);

    if (site.error) container.appendChild(element('div', 'branding-import-feedback error', site.error));
    if (s.lastError && !running) container.appendChild(element('div', 'branding-import-feedback error', s.lastError));
    if (job && job.state === 'done' && job.errors && job.errors.length) {
      const problems = element('ul', 'influencer-site-errors');
      for (const entry of job.errors) {
        const piece = entry.itemId && d.items.find((item) => item.id === entry.itemId);
        problems.appendChild(element('li', '', piece ? `${piece.title || t('influencers.site.untitled')}: ${entry.message}` : entry.message));
      }
      container.appendChild(problems);
    }
    if (running) container.appendChild(element('p', 'influencer-site-progress', jobLine(job)));
    else if (site.note) container.appendChild(element('p', 'influencer-field-hint', site.note));

    if (site.confirm && !running) {
      const confirm = element('div', 'influencer-copy-confirm');
      confirm.appendChild(element('p', '', t('influencers.site.confirmPublic', { name: site.name })));
      const row = element('div', 'branding-card-actions');
      const yes = managerAction(t('influencers.site.confirmPublicYes'), () => run(() => publish(true)), { disabled: site.busy });
      yes.classList.add('primary');
      row.append(yes, managerAction(t('common.cancel'), () => { site.confirm = false; render(); }));
      confirm.appendChild(row);
      container.appendChild(confirm);
    }

    const actions = element('div', 'branding-card-actions');
    actions.appendChild(managerAction(t('influencers.site.save'), () => run(() => save()), { disabled: locked }));
    actions.appendChild(managerAction(t('influencers.site.preview'), () => {
      // open the tab inside the click (a later window.open would be blocked) and fill it once the draft is saved
      const tab = global.open('', '_blank');
      run(async () => {
        const ok = await save({ quiet: true });
        if (tab) {
          if (ok) { tab.opener = null; tab.location.replace(new URL(rel(`${base(site.id).slice(1)}/preview/`), document.baseURI).href); } else tab.close();
        }
      });
    }, { disabled: locked }));
    const cannot = !host.connected || (!published && host.canCreate === false);
    const go = managerAction(t(published ? 'influencers.site.update' : 'influencers.site.publish'), () => run(() => publish(false)), { disabled: locked || cannot || site.confirm });
    go.classList.add('primary');
    actions.appendChild(go);
    container.appendChild(actions);
  }

  /* ---------- the action "Auf die Seite von ..." of a result ---------- */

  let dialog = null;

  function closeDialog() {
    if (dialog) dialog.remove();
    dialog = null;
  }

  async function openDialog({ sessionId, assetId }) {
    closeDialog();
    dialog = element('div', 'modal influencer-site-dialog');
    const panel = element('div', 'modal-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('influencers.site.addTitle'));
    const head = element('div', 'modal-head');
    head.appendChild(element('h2', '', t('influencers.site.addTitle')));
    const close = element('button', 'modal-close', '×');
    close.type = 'button';
    close.title = t('common.close');
    close.setAttribute('aria-label', t('common.close'));
    close.addEventListener('click', closeDialog);
    head.appendChild(close);
    const body = element('div', 'modal-body influencer-site-dialog-body');
    body.appendChild(element('p', 'influencer-field-hint', t('influencers.site.loading')));
    panel.append(head, body);
    dialog.appendChild(panel);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
    dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); closeDialog(); } });
    document.body.appendChild(dialog);
    const mine = dialog;

    let own = [];
    try {
      const answer = await api('/api/influencers');
      own = (answer.influencers || []).filter((entry) => entry.editable === true && !entry.builtin);
    } catch (err) {
      if (dialog !== mine) return;
      body.replaceChildren(element('div', 'branding-import-feedback error', err.message));
      return;
    }
    if (dialog !== mine) return;
    body.replaceChildren();
    if (!own.length) {
      body.appendChild(element('p', '', t('influencers.site.addNone')));
      return;
    }
    const who = select(own[0].id, own.map((entry) => [entry.id, entry.name]), () => {});
    const title = input('input', '', { max: 120, onInput: () => {} });
    const text = input('textarea', '', { max: 1200, rows: 3, onInput: () => {} });
    const feedback = element('div', 'branding-import-feedback error hidden');
    body.append(labelled(t('influencers.site.addWho'), who), labelled(t('influencers.site.itemTitle'), title),
      labelled(t('influencers.site.itemText'), text), element('p', 'influencer-field-hint', t('influencers.site.addHint')), feedback);
    const row = element('div', 'branding-card-actions');
    const add = managerAction(t('influencers.site.addDo'), async () => {
      add.disabled = true;
      feedback.classList.add('hidden');
      const chosen = own.find((entry) => entry.id === who.value);
      try {
        await api(`${base(who.value)}/items`, { method: 'POST', body: JSON.stringify({ sessionId, assetId, title: title.value.trim(), description: text.value.trim() }) });
        if (dialog === mine) closeDialog();
        // the open edit view of that influencer shows the new piece at once
        if (site.id === who.value && site.container && site.container.isConnected) load();
        setStatus(t('influencers.site.added', { name: chosen ? chosen.name : '' }));
      } catch (err) {
        feedback.textContent = err.message;
        feedback.classList.remove('hidden');
        add.disabled = false;
      }
    });
    add.classList.add('primary');
    row.append(add, managerAction(t('common.cancel'), closeDialog));
    body.appendChild(row);
    title.focus();
  }

  // The button of one result. It is in the page from the start and shown by the class `has-website-host` of the body, so results that
  // were drawn before the answer about the host arrived get it too.
  function addButton({ sessionId, assetId, kind, className = 'asset-site-action', icon = null } = {}) {
    if (!sessionId || !assetId || (kind !== 'image' && kind !== 'video')) return null;
    const button = element('button', `${className} site-add-action`);
    button.type = 'button';
    const label = t('influencers.site.addAction');
    button.title = label;
    button.setAttribute('aria-label', label);
    if (icon) button.appendChild(icon);
    else button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDialog({ sessionId, assetId });
    });
    return button;
  }

  /* ---------- the connection of the installation (settings, admins) ---------- */

  const hostState = { status: null, error: '', pendingDisconnect: false, busy: false };

  function renderHost() {
    const section = document.getElementById('websiteHostSection');
    if (!section) return;
    const status = hostState.status;
    section.classList.toggle('hidden', !(status && status.enabled && status.canManage));
    if (!status || !status.enabled || !status.canManage) return;
    const text = document.getElementById('websiteHostStatusText');
    const dot = document.getElementById('websiteHostStatusDot');
    const actions = document.getElementById('websiteHostActions');
    dot.classList.toggle('connected', Boolean(status.connected));
    text.textContent = hostState.error || (status.connected
      ? [t('influencers.site.hostConnected'), status.connectedBy, status.connectedAt ? formatDate(status.connectedAt) : ''].filter(Boolean).join(' · ')
      : t('influencers.site.hostDisconnected'));
    actions.replaceChildren();
    if (!status.connected) {
      actions.appendChild(managerAction(t('influencers.site.hostConnect'), () => { if (!hostState.busy) { hostState.busy = true; connectHost().finally(() => { hostState.busy = false; }); } }));
    } else {
      actions.appendChild(managerAction(hostState.pendingDisconnect ? t('influencers.site.hostReallyDisconnect') : t('influencers.site.hostDisconnect'), async () => {
        if (!hostState.pendingDisconnect) { hostState.pendingDisconnect = true; renderHost(); return; }
        hostState.pendingDisconnect = false;
        try {
          await api('/api/website-host/auth', { method: 'DELETE' });
          hostState.error = '';
        } catch (err) {
          hostState.error = err.message;
        }
        await refreshHost();
      }, { danger: true }));
    }
  }

  async function refreshHost() {
    hostState.pendingDisconnect = false;
    try {
      hostState.status = await api('/api/website-host/status');
    } catch (_) {
      hostState.status = null;
    }
    document.body.classList.toggle('has-website-host', Boolean(hostState.status && hostState.status.enabled));
    renderHost();
    return hostState.status;
  }

  // Back from the host's sign-in: say how it went, once, and take the note out of the address.
  function readReturn() {
    const params = new URLSearchParams(global.location.search);
    const outcome = params.get('websiteHost');
    if (outcome !== 'connected' && outcome !== 'failed') return;
    params.delete('websiteHost');
    const query = params.toString();
    global.history.replaceState(null, '', `${global.location.pathname}${query ? `?${query}` : ''}${global.location.hash}`);
    setStatus(t(outcome === 'connected' ? 'influencers.site.hostConnectedDone' : 'influencers.site.hostConnectFailed'));
  }

  global.OCInfluencerSite = { mount, reset, addButton, refreshHost, rerender: () => { render(); renderHost(); } };
  readReturn();
  refreshHost();
})(window);
