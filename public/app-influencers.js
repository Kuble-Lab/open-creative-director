'use strict';

// The window "Influencer" (side menu, next to "Brandings"): the AI influencers of the caller (lib/influencers.js, /api/influencers). A list
// with the portrait, and a form to make and change one: identity texts, voice, style, up to six reference images. Claudia comes with the
// app as a read-only example; "Make a copy" turns her (or one's own) into a new one. Making one needs the confirmation that the figure
// shows no real person without their consent; the server asks for it too.
//
// Loaded after the chat scripts; it uses their helpers (api, rel, t, setStatus, textNode, managerAction, formatDate) only when it is used.

(function initInfluencers() {
  const modal = document.getElementById('influencersModal');
  const body = document.getElementById('influencersBody');
  const openButton = document.getElementById('influencersBtn');
  const closeButton = document.getElementById('influencersClose');
  if (!modal || !body || !openButton || !closeButton) return;

  const MAX_IMAGES = 6;
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
  const IMAGE_TYPES = /\.(png|jpe?g|webp)$/i;
  // the fields of the form in their order: [id, control, most characters, rows of a textarea]
  const FIELDS = [
    ['name', 'input', 60],
    ['tagline', 'input', 300],
    ['full', 'textarea', 1500, 5],
    ['short', 'textarea', 400, 2],
    ['looks', 'textarea', 1000, 3],
    ['face', 'textarea', 400, 2],
    ['never', 'textarea', 400, 2],
    ['style', 'textarea', 1000, 3],
    ['credit', 'input', 200]
  ];
  const VOICE_FIELDS = [
    ['voiceId', 'input', 64],
    ['name', 'input', 80],
    ['description', 'textarea', 400, 2]
  ];
  const REQUIRED = new Set(['name', 'full']);

  // view: 'list', 'new' or 'edit' (with `current`, the influencer as the server gave it)
  const ui = { view: 'list', list: [], maxOwned: 10, owned: 0, current: null, loading: false, error: '', pendingDelete: null, pendingCopy: null, busy: false };

  const isOpen = () => !modal.classList.contains('hidden');
  const assetUrl = (id, file) => rel(`api/influencers/${encodeURIComponent(id)}/assets/${encodeURIComponent(file)}`);
  // admins and the local mode make shared influencers, which the limit does not count
  const limited = () => !OCAccess.canAdminister();
  const atLimit = () => limited() && ui.owned >= ui.maxOwned;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function loadList() {
    const data = await api('/api/influencers');
    ui.list = Array.isArray(data.influencers) ? data.influencers : [];
    ui.maxOwned = Number(data.maxOwned) || 10;
    ui.owned = Number(data.owned) || 0;
  }

  function portrait(influencer, className) {
    const frame = element('div', className);
    const file = influencer.portrait || (Array.isArray(influencer.images) ? influencer.images[0] : null);
    if (file) {
      const image = document.createElement('img');
      image.src = assetUrl(influencer.id, file);
      image.alt = '';
      image.loading = 'lazy';
      frame.appendChild(image);
    } else {
      frame.classList.add('empty');
      frame.textContent = [...String(influencer.name || '?').trim()][0]?.toUpperCase() || '?';
    }
    return frame;
  }

  // The confirmation every new influencer needs (a copy too): the box and the text; `onChange(checked)` says when it is ticked.
  function consentBox(onChange) {
    const label = element('label', 'influencer-consent');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => onChange(box.checked));
    label.append(box, element('span', '', t('influencers.consent')));
    return label;
  }

  /* ---------- the list ---------- */

  function renderList() {
    body.innerHTML = '';
    body.appendChild(element('p', 'influencer-intro', t('influencers.intro')));

    const bar = element('div', 'influencer-bar');
    bar.appendChild(element('span', 'influencer-count', limited() ? t('influencers.count', { n: ui.owned, max: ui.maxOwned }) : ''));
    const add = managerAction(t('influencers.new'), () => show('new'), { disabled: atLimit() });
    add.classList.add('primary');
    if (atLimit()) add.title = t('influencers.limit', { max: ui.maxOwned });
    bar.appendChild(add);
    body.appendChild(bar);

    if (ui.error) body.appendChild(element('div', 'branding-manager-empty error', ui.error));
    if (ui.loading && !ui.list.length) {
      body.appendChild(element('div', 'branding-manager-empty', t('influencers.loading')));
      return;
    }

    const list = element('div', 'branding-manager-list');
    for (const influencer of ui.list) list.appendChild(card(influencer));
    body.appendChild(list);
  }

  function card(influencer) {
    const item = element('article', 'branding-card influencer-card');
    item.dataset.influencerId = influencer.id;
    const head = element('div', 'influencer-card-head');
    head.appendChild(portrait(influencer, 'influencer-portrait'));
    const copy = element('div', 'branding-card-copy');
    const name = element('h3', '', influencer.name);
    if (influencer.builtin) name.appendChild(element('span', 'influencer-badge', t('influencers.example')));
    copy.appendChild(name);
    if (influencer.tagline) copy.appendChild(element('p', '', influencer.tagline));
    const facts = [t('influencers.imageCount', { n: influencer.imageCount || 0 }), influencer.hasVoice ? t('influencers.hasVoice') : t('influencers.noVoice')];
    if (influencer.owner) facts.push(influencer.owner);
    copy.appendChild(element('div', 'branding-card-date', facts.join(' · ')));
    head.appendChild(copy);
    item.appendChild(head);

    const editable = influencer.editable === true && !influencer.builtin;
    const actions = element('div', 'branding-card-actions');
    actions.appendChild(managerAction(editable ? t('influencers.edit') : t('influencers.view'), () => openInfluencer(influencer.id)));
    actions.appendChild(managerAction(t('influencers.copy'), () => {
      ui.pendingCopy = ui.pendingCopy === influencer.id ? null : influencer.id;
      ui.pendingDelete = null;
      render();
    }, { disabled: atLimit() }));
    if (editable) {
      const confirming = ui.pendingDelete === influencer.id;
      actions.appendChild(managerAction(confirming ? t('common.reallyDelete') : t('common.delete'), () => {
        if (!confirming) {
          ui.pendingDelete = influencer.id;
          ui.pendingCopy = null;
          render();
          return;
        }
        removeInfluencer(influencer).catch(fail);
      }, { danger: true }));
    }
    item.appendChild(actions);
    if (ui.pendingCopy === influencer.id) item.appendChild(copyConfirm(influencer));
    return item;
  }

  // "Make a copy" asks for the same confirmation as a new influencer before it copies.
  function copyConfirm(influencer) {
    const block = element('div', 'influencer-copy-confirm');
    const go = managerAction(t('influencers.copyConfirm'), () => {
      go.disabled = true;
      duplicate(influencer).catch((err) => {
        go.disabled = false;
        fail(err);
      });
    }, { disabled: true });
    go.classList.add('primary');
    block.appendChild(consentBox((checked) => { go.disabled = !checked; }));
    const row = element('div', 'branding-card-actions');
    row.append(go, managerAction(t('common.cancel'), () => {
      ui.pendingCopy = null;
      render();
    }));
    block.appendChild(row);
    return block;
  }

  /* ---------- the form ---------- */

  function field(id, control, max, rows, value, { prefix = 'influencers.field', disabled = false } = {}) {
    const wrap = element('label', 'influencer-field');
    const key = `${prefix}.${id}`;
    wrap.appendChild(element('span', 'influencer-field-label', `${t(key)}${prefix === 'influencers.field' && REQUIRED.has(id) ? ' *' : ''}`));
    const input = document.createElement(control);
    input.className = 'settings-input';
    if (control === 'textarea') input.rows = rows || 3;
    else input.type = 'text';
    input.maxLength = max;
    input.value = value || '';
    input.disabled = disabled;
    input.dataset.field = prefix === 'influencers.field' ? id : `voice.${id}`;
    wrap.appendChild(input);
    const hint = t(`${key}.hint`);
    // a field without a hint has no key for one (t gives the key back)
    if (hint && hint !== `${key}.hint`) wrap.appendChild(element('span', 'influencer-field-hint', hint));
    return wrap;
  }

  function formValues(form) {
    const values = { voice: {} };
    for (const input of form.querySelectorAll('[data-field]')) {
      const name = input.dataset.field;
      if (name.startsWith('voice.')) values.voice[name.slice(6)] = input.value.trim();
      else values[name] = input.value.trim();
    }
    return values;
  }

  function renderForm() {
    const creating = ui.view === 'new';
    const influencer = creating ? { voice: {} } : ui.current;
    const editable = creating || (influencer.editable === true && !influencer.builtin);
    body.innerHTML = '';

    const top = element('div', 'influencer-form-top');
    top.appendChild(managerAction(`← ${t('influencers.back')}`, () => show('list')));
    top.appendChild(element('h3', 'influencer-form-title', creating ? t('influencers.newTitle') : influencer.name));
    body.appendChild(top);
    if (!editable) body.appendChild(element('p', 'influencer-note', t(influencer.builtin ? 'influencers.readonlyExample' : 'influencers.readonlyShared')));
    if (ui.error) body.appendChild(element('div', 'branding-import-feedback error', ui.error));

    const form = element('form', 'influencer-form');
    form.noValidate = true;
    for (const [id, control, max, rows] of FIELDS) form.appendChild(field(id, control, max, rows, influencer[id], { disabled: !editable }));

    const voice = element('fieldset', 'influencer-group');
    voice.appendChild(element('legend', '', t('influencers.voice')));
    for (const [id, control, max, rows] of VOICE_FIELDS) {
      voice.appendChild(field(id, control, max, rows, influencer.voice?.[id], { prefix: 'influencers.voiceField', disabled: !editable }));
    }
    form.appendChild(voice);

    if (!creating) form.appendChild(imagesBlock(influencer, editable));
    else form.appendChild(element('p', 'influencer-note', t('influencers.imagesAfterCreate')));

    if (editable) {
      const save = managerAction(creating ? t('influencers.create') : t('common.save'), () => {});
      save.type = 'submit';
      save.classList.add('primary');
      if (creating) {
        save.disabled = true;
        form.appendChild(consentBox((checked) => { save.disabled = !checked; }));
      } else if (influencer.consent?.confirmedAt) {
        form.appendChild(element('p', 'influencer-field-hint', t('influencers.consentGiven', { date: formatDate(influencer.consent.confirmedAt) })));
      }
      const actions = element('div', 'branding-card-actions');
      actions.appendChild(save);
      form.appendChild(actions);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (ui.busy) return;
        const values = formValues(form);
        if (!values.name || !values.full) {
          ui.error = t('influencers.required');
          keepValues(values);
          return;
        }
        ui.busy = true;
        save.disabled = true;
        saveInfluencer(values, creating).catch((err) => {
          keepValues(values, err.message);
        }).finally(() => { ui.busy = false; });
      });
    }
    body.appendChild(form);
    body.appendChild(element('p', 'influencer-note', t('influencers.nodeHint')));
  }

  // A failed save shows its message and keeps what was typed.
  function keepValues(values, message) {
    if (message) ui.error = message;
    if (ui.view === 'edit') ui.current = { ...ui.current, ...values };
    renderForm();
    if (ui.view === 'new') {
      for (const input of body.querySelectorAll('[data-field]')) {
        const name = input.dataset.field;
        input.value = name.startsWith('voice.') ? values.voice[name.slice(6)] || '' : values[name] || '';
      }
    }
  }

  function imagesBlock(influencer, editable) {
    const block = element('div', 'influencer-group');
    const images = Array.isArray(influencer.images) ? influencer.images : [];
    block.appendChild(element('div', 'influencer-field-label', t('influencers.images', { n: images.length, max: MAX_IMAGES })));
    const grid = element('div', 'influencer-images');
    for (const file of images) {
      const tile = element('div', 'influencer-image');
      const image = document.createElement('img');
      image.src = assetUrl(influencer.id, file);
      image.alt = file;
      image.loading = 'lazy';
      tile.appendChild(image);
      if (editable) {
        const remove = element('button', 'influencer-image-remove', '×');
        remove.type = 'button';
        remove.title = t('influencers.imageRemove', { name: file });
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => {
          remove.disabled = true;
          removeImage(influencer, file).catch(fail);
        });
        tile.appendChild(remove);
      }
      grid.appendChild(tile);
    }
    if (images.length) block.appendChild(grid);
    else block.appendChild(element('p', 'influencer-field-hint', t('influencers.imagesNone')));
    if (editable) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
      input.multiple = true;
      input.hidden = true;
      input.addEventListener('change', () => {
        const files = [...input.files];
        input.value = '';
        uploadImages(influencer, files).catch(fail);
      });
      const add = managerAction(t('influencers.imageAdd'), () => input.click(), { disabled: images.length >= MAX_IMAGES });
      block.append(input, add);
      block.appendChild(element('p', 'influencer-field-hint', t('influencers.imagesHint', { max: MAX_IMAGES })));
    }
    return block;
  }

  /* ---------- what the buttons do ---------- */

  function fail(err) {
    ui.error = err.message;
    render();
  }

  function render() {
    if (ui.view === 'list') renderList();
    else renderForm();
  }

  function show(view) {
    ui.view = view;
    ui.error = '';
    ui.pendingDelete = null;
    ui.pendingCopy = null;
    if (view !== 'edit') ui.current = null;
    render();
    body.scrollTop = 0;
    if (view === 'list') refresh().catch(fail);
  }

  async function refresh() {
    ui.loading = true;
    try {
      await loadList();
    } finally {
      ui.loading = false;
    }
    if (isOpen() && ui.view === 'list') render();
  }

  async function openInfluencer(id) {
    try {
      ui.current = await api(`/api/influencers/${encodeURIComponent(id)}`);
      show('edit');
    } catch (err) {
      fail(err);
    }
  }

  async function saveInfluencer(values, creating) {
    if (creating) {
      const made = await api('/api/influencers', { method: 'POST', body: JSON.stringify({ ...values, consent: true }) });
      ui.owned += 1;
      // straight on to the same form, now with the images
      ui.current = { ...made, editable: true };
      show('edit');
      setStatusI18n('influencers.created');
      return;
    }
    const saved = await api(`/api/influencers/${encodeURIComponent(ui.current.id)}`, { method: 'PATCH', body: JSON.stringify(values) });
    ui.current = { ...saved, editable: true };
    ui.error = '';
    render();
    setStatusI18n('influencers.saved');
  }

  async function duplicate(influencer) {
    const made = await api(`/api/influencers/${encodeURIComponent(influencer.id)}/duplicate`, { method: 'POST', body: JSON.stringify({ consent: true }) });
    ui.current = { ...made, editable: true };
    show('edit');
    setStatusI18n('influencers.copied');
  }

  async function removeInfluencer(influencer) {
    await api(`/api/influencers/${encodeURIComponent(influencer.id)}`, { method: 'DELETE' });
    ui.pendingDelete = null;
    setStatusI18n('influencers.deleted');
    await refresh();
  }

  async function uploadImages(influencer, files) {
    let count = Array.isArray(influencer.images) ? influencer.images.length : 0;
    let latest = null;
    const problems = [];
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.name || '')) problems.push(t('influencers.imageWrongType', { name: file.name }));
      else if (file.size > MAX_IMAGE_BYTES) problems.push(t('influencers.imageTooLarge', { name: file.name }));
      else if (count >= MAX_IMAGES) problems.push(t('influencers.imageTooMany', { max: MAX_IMAGES }));
      else {
        try {
          // the raw file as the body, as the fonts of a branding (api() would send it as JSON)
          latest = await api(`/api/influencers/${encodeURIComponent(influencer.id)}/images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
            body: file
          });
          count += 1;
        } catch (err) {
          problems.push(`${file.name}: ${err.message}`);
        }
      }
    }
    if (latest && ui.current?.id === influencer.id) ui.current = { ...latest, editable: true };
    ui.error = [...new Set(problems)].join(' ');
    render();
  }

  async function removeImage(influencer, file) {
    const saved = await api(`/api/influencers/${encodeURIComponent(influencer.id)}/images/${encodeURIComponent(file)}`, { method: 'DELETE' });
    if (ui.current?.id === influencer.id) ui.current = { ...saved, editable: true };
    ui.error = '';
    render();
  }

  function open() {
    modal.classList.remove('hidden');
    closeButton.focus();
    show('list');
  }

  function close() {
    modal.classList.add('hidden');
    ui.current = null;
  }

  openButton.addEventListener('click', () => {
    closeMobileSidebar();
    open();
  });
  closeButton.addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen() && !event.defaultPrevented) close();
  });

  window.OCDInfluencers = { open, close };
})();
