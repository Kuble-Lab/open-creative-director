'use strict';

// Asset picker and chat bridge of the node view (SPEC §17, WP7).
// open(): modal with three sources for media inputs: upload from disk, "from chats" (any finished
// image / video / audio asset of a chat session, copied into the workflow) and "this workflow"
// (assets already stored in the backing session). chooseChat() / sendToChat() are the other
// direction: pick a chat and forward the result of a node into it. In-app dialogs only.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const ui = OCD.ui;
  const api = OCD.api;
  const { el, icon, T } = ui;

  const enc = encodeURIComponent;
  const EXT_KIND = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.mp4': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio' };
  const PAGE = 30;

  // Media kind of a chat ledger entry (kind image/video/audio, or an upload classified by extension).
  function ledgerKind(entry) {
    if (!entry || entry.pending) return null;
    if (['image', 'video', 'audio'].includes(entry.kind)) return entry.kind;
    if (entry.kind === 'upload') {
      const match = /\.[A-Za-z0-9]+$/.exec(String(entry.file || ''));
      return match ? EXT_KIND[match[0].toLowerCase()] || null : null;
    }
    return null;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const lang = typeof global.getLang === 'function' ? global.getLang() : undefined;
    try {
      return new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(date);
    } catch (_) {
      return date.toLocaleString();
    }
  }

  // Small preview tile for an asset-like object { kind|type, url, file, prompt? }.
  function tile(item, kind) {
    const url = api.rel(item.url || '');
    const wrap = el('span', { class: `nv-ap-thumb is-${kind}` });
    if (kind === 'image') wrap.append(el('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' }));
    else if (kind === 'video') wrap.append(el('video', { src: `${url}#t=0.1`, muted: true, preload: 'metadata', playsinline: true }));
    else wrap.append(icon('audio', 22));
    return wrap;
  }

  function tabButton(id, label, active, onClick) {
    const button = el('button', { type: 'button', class: `nv-ap-tab ${active ? 'is-active' : ''}`.trim(), role: 'tab', 'aria-selected': active ? 'true' : 'false', dataset: { tab: id }, text: label });
    button.addEventListener('click', onClick);
    return button;
  }

  /* ---------- chat list (shared by the picker and the send dialog) ---------- */

  // A searchable, pageable list of chat sessions. onSelect(chat), onConfirm(chat) on double click.
  function chatList({ onSelect, onConfirm }) {
    const root = el('div', { class: 'nv-ap-chats' });
    const search = el('input', { class: 'nv-input nv-ap-search', type: 'search', placeholder: T('nodes.picker.searchChats'), 'aria-label': T('nodes.picker.searchChats'), autocomplete: 'off' });
    const list = el('div', { class: 'nv-ap-chatlist', role: 'listbox' });
    const more = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-ap-more hidden', text: T('nodes.picker.loadMore') });
    root.append(search, list, more);
    let offset = 0;
    let query = '';
    let selectedId = null;
    let token = 0;
    let timer = null;

    function row(chat) {
      const item = el('button', { type: 'button', class: `nv-ap-chat ${chat.id === selectedId ? 'is-selected' : ''}`.trim(), role: 'option', 'aria-selected': chat.id === selectedId ? 'true' : 'false', dataset: { id: chat.id } });
      item.append(el('span', { class: 'nv-ap-chat-title', text: chat.title || T('nodes.picker.untitledChat') }));
      const meta = [chat.folder, formatDate(chat.updatedAt)].filter(Boolean).join(' · ');
      if (meta) item.append(el('span', { class: 'nv-ap-chat-meta', text: meta }));
      item.addEventListener('click', () => {
        selectedId = chat.id;
        for (const other of list.querySelectorAll('.nv-ap-chat')) {
          const on = other.dataset.id === chat.id;
          other.classList.toggle('is-selected', on);
          other.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        onSelect(chat);
      });
      item.addEventListener('dblclick', () => onConfirm && onConfirm(chat));
      return item;
    }

    async function load(reset) {
      const mine = ++token;
      if (reset) {
        offset = 0;
        list.textContent = '';
        list.append(el('div', { class: 'nv-ap-note', text: T('nodes.picker.loading') }));
      }
      more.disabled = true;
      try {
        const payload = await api.request('GET', `/api/sessions?limit=${PAGE}&offset=${offset}${query ? `&q=${enc(query)}` : ''}`);
        if (mine !== token) return;
        if (reset) list.textContent = '';
        for (const chat of payload.sessions || []) list.append(row(chat));
        offset += (payload.sessions || []).length;
        more.classList.toggle('hidden', !payload.hasMore);
        if (!list.children.length) list.append(el('div', { class: 'nv-ap-note', text: T('nodes.picker.noChats') }));
      } catch (error) {
        if (mine !== token) return;
        if (reset) list.textContent = '';
        list.append(el('div', { class: 'nv-ap-note is-error', text: T('nodes.picker.loadFailed', { error: error.message }) }));
      } finally {
        more.disabled = false;
      }
    }

    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        query = search.value.trim();
        load(true);
      }, 220);
    });
    more.addEventListener('click', () => load(false));
    load(true);
    return { el: root, focus: () => search.focus(), selected: () => selectedId };
  }

  /* ---------- asset picker ---------- */

  // Opens the picker. options: { kind: 'image'|'video'|'audio', multi, max, workflowId, uploadFile(file, {accept, onProgress}) }.
  // Resolves an array of port values (already stored in the workflow's backing session) or null when cancelled.
  function open(options) {
    const kind = ['image', 'video', 'audio'].includes(options.kind) ? options.kind : 'image';
    const multi = Boolean(options.multi);
    const max = multi ? options.max || 50 : 1;
    const workflowId = options.workflowId;
    let tab = 'upload';
    // selection: key -> { key, load(): Promise<value> }
    const selected = new Map();
    let chatId = null;
    let uploaded = null;

    const body = el('div', { class: 'nv-ap' });
    const tabs = el('div', { class: 'nv-ap-tabs', role: 'tablist' });
    const pane = el('div', { class: 'nv-ap-pane' });
    const status = el('div', { class: 'nv-ap-status', role: 'status' });
    body.append(tabs, pane, status);
    let panel = null;
    let busy = false;

    const setStatus = (text, error) => {
      status.textContent = text || '';
      status.classList.toggle('is-error', Boolean(error));
    };

    function refreshPrimary() {
      if (!panel) return;
      const primary = panel.querySelector('.nv-dialog-actions .nv-btn-primary');
      if (!primary) return;
      const count = selected.size;
      primary.disabled = tab === 'upload' ? false : busy || count === 0;
      primary.classList.toggle('hidden', tab === 'upload');
      primary.textContent = count > 1 ? T('nodes.picker.useCount', { count }) : T('nodes.picker.use');
    }

    function paintSelection(container) {
      for (const cell of container.querySelectorAll('.nv-ap-cell')) {
        const on = selected.has(cell.dataset.key);
        cell.classList.toggle('is-selected', on);
        cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    function toggle(key, loader, container) {
      if (selected.has(key)) selected.delete(key);
      else {
        if (!multi) selected.clear();
        if (selected.size >= max) {
          setStatus(T('nodes.asset.tooMany', { max }), true);
          return;
        }
        selected.set(key, { key, load: loader });
      }
      setStatus('');
      paintSelection(container);
      refreshPrimary();
    }

    function grid(container, items) {
      container.textContent = '';
      if (!items.length) {
        container.append(el('div', { class: 'nv-ap-note', text: T(`nodes.picker.none.${kind}`) }));
        return;
      }
      for (const item of items) {
        const cell = el('button', { type: 'button', class: 'nv-ap-cell', dataset: { key: item.key }, 'aria-pressed': 'false', title: item.title || '' });
        cell.append(tile(item, kind), el('span', { class: 'nv-ap-cell-name', text: item.label }), el('span', { class: 'nv-ap-check' }, icon('check', 12)));
        cell.addEventListener('click', () => toggle(item.key, item.load, container));
        container.append(cell);
      }
      paintSelection(container);
    }

    /* upload tab */
    function renderUpload() {
      const accept = kind === 'image' ? 'image/*,.svg' : `${kind}/*`;
      const input = el('input', { type: 'file', class: 'nv-file-input', accept, multiple: multi || null, tabindex: '-1' });
      const zone = el('button', { type: 'button', class: 'nv-ap-dropzone' });
      zone.append(icon('upload', 26), el('strong', { text: multi ? T('nodes.asset.addFiles') : T('nodes.asset.upload') }), el('small', { text: T(`nodes.asset.hint.${kind}`) }));
      pane.append(zone, input);
      const handle = async (files) => {
        const list = Array.from(files || []);
        if (!list.length || busy) return;
        busy = true;
        zone.classList.add('is-busy');
        const values = [];
        try {
          const chosen = multi ? list.slice(0, max) : [list[0]];
          let done = 0;
          for (const file of chosen) {
            setStatus(T('nodes.asset.uploading', { name: file.name, done: done + 1, total: chosen.length }));
            values.push(await options.uploadFile(file, { accept: kind, onProgress: (ratio) => setStatus(`${T('nodes.asset.uploading', { name: file.name, done: done + 1, total: chosen.length })} ${Math.round(ratio * 100)}%`) }));
            done += 1;
          }
          finish(values);
        } catch (error) {
          setStatus(error.message, true);
        } finally {
          busy = false;
          zone.classList.remove('is-busy');
        }
      };
      zone.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        handle(input.files);
        input.value = '';
      });
      for (const type of ['dragenter', 'dragover']) {
        zone.addEventListener(type, (event) => {
          event.preventDefault();
          zone.classList.add('is-drop');
        });
      }
      zone.addEventListener('dragleave', () => zone.classList.remove('is-drop'));
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('is-drop');
        handle(event.dataTransfer && event.dataTransfer.files);
      });
    }

    /* chats tab */
    function renderChats() {
      const layout = el('div', { class: 'nv-ap-split' });
      const gridBox = el('div', { class: 'nv-ap-grid' });
      gridBox.append(el('div', { class: 'nv-ap-note', text: T('nodes.picker.pickChat') }));
      const list = chatList({
        onSelect: (chat) => loadChatAssets(chat),
        onConfirm: null
      });
      layout.append(list.el, gridBox);
      pane.append(layout);
      async function loadChatAssets(chat) {
        chatId = chat.id;
        gridBox.textContent = '';
        gridBox.append(el('div', { class: 'nv-ap-note', text: T('nodes.picker.loading') }));
        try {
          const payload = await api.request('GET', `/api/sessions/${enc(chat.id)}`);
          if (chatId !== chat.id) return;
          const items = (payload.assets || [])
            .filter((entry) => ledgerKind(entry) === kind && entry.url)
            .map((entry) => ({
              key: `${chat.id}/${entry.id}`,
              url: entry.url,
              label: entry.id,
              title: entry.prompt || entry.id,
              load: async () => (await api.importAsset(workflowId, chat.id, entry.id)).value
            }));
          grid(gridBox, items.reverse());
        } catch (error) {
          if (chatId !== chat.id) return;
          gridBox.textContent = '';
          gridBox.append(el('div', { class: 'nv-ap-note is-error', text: T('nodes.picker.loadFailed', { error: error.message }) }));
        }
      }
      setTimeout(() => list.focus(), 0);
    }

    /* this workflow tab */
    async function renderWorkflow() {
      const box = el('div', { class: 'nv-ap-grid is-full' });
      box.append(el('div', { class: 'nv-ap-note', text: T('nodes.picker.loading') }));
      pane.append(box);
      try {
        const payload = await api.assets(workflowId);
        if (tab !== 'workflow') return;
        const items = (payload.assets || [])
          .filter((value) => value.type === kind)
          .map((value) => ({
            key: `wf/${value.assetId}`,
            url: value.url,
            label: value.assetId,
            title: value.prompt || value.assetId,
            load: async () => {
              const { prompt, createdAt, ...clean } = value;
              void prompt;
              void createdAt;
              return clean;
            }
          }));
        grid(box, items.reverse());
      } catch (error) {
        if (tab !== 'workflow') return;
        box.textContent = '';
        box.append(el('div', { class: 'nv-ap-note is-error', text: T('nodes.picker.loadFailed', { error: error.message }) }));
      }
    }

    function drawTabs() {
      tabs.textContent = '';
      const defs = [
        ['upload', T('nodes.picker.tabUpload')],
        ['chats', T('nodes.picker.tabChats')],
        ['workflow', T('nodes.picker.tabWorkflow')]
      ];
      for (const [id, label] of defs) {
        tabs.append(
          tabButton(id, label, id === tab, () => {
            if (id === tab || busy) return;
            tab = id;
            selected.clear();
            chatId = null;
            setStatus('');
            drawTabs();
            drawPane();
            refreshPrimary();
          })
        );
      }
    }

    function drawPane() {
      pane.textContent = '';
      if (tab === 'upload') renderUpload();
      else if (tab === 'chats') renderChats();
      else renderWorkflow();
    }

    // Upload tab: the freshly uploaded values are handed to the (hidden) primary button, which closes the dialog.
    function finish(values) {
      uploaded = values;
      const primary = panel && panel.querySelector('.nv-dialog-actions .nv-btn-primary');
      if (primary) primary.click();
    }

    return ui
      .dialog({
        title: options.title || T(`nodes.picker.title.${kind}`),
        body,
        width: 760,
        buttons: [
          { label: T('nodes.common.cancel'), value: null, cancel: true },
          {
            label: T('nodes.picker.use'),
            value: null,
            primary: true,
            onClick: (close) => {
              if (uploaded) {
                close(uploaded);
                return false;
              }
              if (busy || !selected.size) return false;
              busy = true;
              refreshPrimary();
              setStatus(T('nodes.picker.importing'));
              Promise.all([...selected.values()].map((entry) => entry.load()))
                .then((values) => close(values))
                .catch((error) => {
                  busy = false;
                  setStatus(T('nodes.picker.importFailed', { error: error.message }), true);
                  refreshPrimary();
                });
              return false;
            }
          }
        ],
        onOpen: (dialogPanel) => {
          panel = dialogPanel;
          dialogPanel.classList.add('is-wide');
          drawTabs();
          drawPane();
          refreshPrimary();
        }
      })
      .then((result) => (Array.isArray(result) ? result : null));
  }

  /* ---------- chat bridge ---------- */

  // Lets the user pick a chat; resolves { id, title } or null.
  function chooseChat(options = {}) {
    let chosen = null;
    let panel = null;
    const list = chatList({
      onSelect: (chat) => {
        chosen = chat;
        update();
      },
      onConfirm: (chat) => {
        chosen = chat;
        const primary = panel && panel.querySelector('.nv-dialog-actions .nv-btn-primary');
        if (primary) primary.click();
      }
    });
    const body = el('div', { class: 'nv-ap nv-ap-send' }, list.el);
    function update() {
      const primary = panel && panel.querySelector('.nv-dialog-actions .nv-btn-primary');
      if (primary) primary.disabled = !chosen;
    }
    return ui
      .dialog({
        title: options.title || T('nodes.send.title'),
        message: options.message || T('nodes.send.message'),
        body,
        width: 520,
        buttons: [
          { label: T('nodes.common.cancel'), value: null, cancel: true },
          { label: options.confirmLabel || T('nodes.send.confirm'), value: '__chat__', primary: true }
        ],
        onOpen: (dialogPanel) => {
          panel = dialogPanel;
          update();
          setTimeout(() => list.focus(), 0);
        }
      })
      .then((result) => (result === '__chat__' && chosen ? { id: chosen.id, title: chosen.title || T('nodes.picker.untitledChat') } : null));
  }

  // Sends the result of a node into a chat the user picks. target: { workflowId, nodeId, entry?, variant?, port? }.
  async function sendToChat(target) {
    const chat = await chooseChat();
    if (!chat) return null;
    try {
      const body = { nodeId: target.nodeId, sessionId: chat.id };
      if (target.entry) body.entry = target.entry;
      if (Number.isInteger(target.variant)) body.variant = target.variant;
      if (target.port) body.port = target.port;
      const result = await api.request('POST', `/api/workflows/${enc(target.workflowId)}/send-to-chat`, body);
      const notice = ui.toast(T('nodes.send.done', { title: chat.title }), { timeout: 9000 });
      const open = el('button', { type: 'button', class: 'nv-link nv-toast-action', text: T('nodes.send.openChat') });
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        global.location.hash = `#s=${chat.id}`;
      });
      notice.append(' ', open);
      return { chat, result };
    } catch (error) {
      ui.toast(T('nodes.send.failed', { error: error.message }), { kind: 'error' });
      return null;
    }
  }

  OCD.assetPicker = { open, chooseChat, sendToChat, ledgerKind };
})(window);
