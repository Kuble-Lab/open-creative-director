'use strict';

// Interface of the personal Suno connection: the dialog "Suno" in the account menu. Server: lib/suno-routes.js, routes
// /api/suno/status, /api/suno/connect and /api/suno/auth. Every signed-in person connects their own Suno account; the
// entry does not depend on the admin settings. Without user management (local mode) the server refuses the routes,
// so the entry stays out.
//
//   OCSuno.attach()      adds the menu entry "Suno" (section 'account' of the shell menu); called by public/shell.js
//   OCSuno.open()        opens the dialog and reads the state once (no polling)
//   OCSuno.close()
//   OCSuno.rerender()    language change
//
// "Connect" asks the server for the address of the Suno sign-in and goes there in the same window; Suno sends the
// person back to the start page, where the dialog opens once more and shows the new state. The dialog builds its own
// markup with the classes of the other dialogs. Everything that comes from the server is written as text, never as
// HTML; there are no native dialogs. The texts live here (DE/EN/ES) and follow the language of the page.
(function (global) {
  const TEXTS = {
    de: {
      menu: 'Suno',
      menuTitle: 'Eigenes Suno-Konto verbinden oder trennen',
      title: 'Suno',
      close: 'Schliessen',
      intro: 'Verbinde dein eigenes Suno-Konto. Die Verbindung gilt nur für dich und lässt sich jederzeit trennen.',
      status: 'Status',
      loading: 'Status wird geladen…',
      connected: 'Verbunden',
      disconnected: 'Nicht verbunden',
      unknown: 'Unbekannt',
      connectedHint: 'Dein Suno-Konto ist mit diesem Zugang verbunden.',
      disconnectedHint: 'Zum Verbinden meldest du dich bei Suno an. Danach kommst du automatisch hierher zurück.',
      connect: 'Mit Suno verbinden',
      redirecting: 'Weiterleitung zu Suno…',
      disconnect: 'Verbindung trennen',
      disconnectConfirm: 'Wirklich trennen?',
      disconnecting: 'Wird getrennt…',
      disconnectedDone: 'Die Verbindung zu Suno ist getrennt.',
      retry: 'Erneut versuchen',
      errNetwork: 'Keine Verbindung zum Server. Prüfe das Netz und versuche es nochmals.',
      errLogin: 'Bitte zuerst anmelden.',
      errOrigin: 'Die Anfrage wurde abgelehnt. Lade die Seite neu und versuche es nochmals.',
      errSetup: 'Suno ist noch nicht eingerichtet.',
      errBusy: 'Zu viele Anmeldungen laufen gerade. Bitte später nochmals versuchen.',
      errRedirect: 'Suno hat keine gültige Anmeldeadresse geliefert.',
      errGeneric: 'Die Suno-Anfrage ist fehlgeschlagen.'
    },
    en: {
      menu: 'Suno',
      menuTitle: 'Connect or disconnect your own Suno account',
      title: 'Suno',
      close: 'Close',
      intro: 'Connect your own Suno account. The connection is yours alone and can be removed at any time.',
      status: 'Status',
      loading: 'Loading status…',
      connected: 'Connected',
      disconnected: 'Not connected',
      unknown: 'Unknown',
      connectedHint: 'Your Suno account is connected to this login.',
      disconnectedHint: 'To connect, you sign in at Suno. Afterwards you return here automatically.',
      connect: 'Connect to Suno',
      redirecting: 'Redirecting to Suno…',
      disconnect: 'Disconnect',
      disconnectConfirm: 'Really disconnect?',
      disconnecting: 'Disconnecting…',
      disconnectedDone: 'The connection to Suno has been removed.',
      retry: 'Try again',
      errNetwork: 'No connection to the server. Check your network and try again.',
      errLogin: 'Please sign in first.',
      errOrigin: 'The request was refused. Reload the page and try again.',
      errSetup: 'Suno has not been set up yet.',
      errBusy: 'Too many sign-ins are running right now. Please try again later.',
      errRedirect: 'Suno did not return a valid sign-in address.',
      errGeneric: 'The Suno request failed.'
    },
    es: {
      menu: 'Suno',
      menuTitle: 'Conectar o desconectar tu propia cuenta de Suno',
      title: 'Suno',
      close: 'Cerrar',
      intro: 'Conecta tu propia cuenta de Suno. La conexión es solo tuya y puedes quitarla en cualquier momento.',
      status: 'Estado',
      loading: 'Cargando el estado…',
      connected: 'Conectado',
      disconnected: 'No conectado',
      unknown: 'Desconocido',
      connectedHint: 'Tu cuenta de Suno está conectada a este acceso.',
      disconnectedHint: 'Para conectar, inicias sesión en Suno. Después vuelves aquí automáticamente.',
      connect: 'Conectar con Suno',
      redirecting: 'Redirigiendo a Suno…',
      disconnect: 'Desconectar',
      disconnectConfirm: '¿Desconectar de verdad?',
      disconnecting: 'Desconectando…',
      disconnectedDone: 'Se ha quitado la conexión con Suno.',
      retry: 'Reintentar',
      errNetwork: 'Sin conexión con el servidor. Comprueba la red e inténtalo de nuevo.',
      errLogin: 'Inicia sesión primero.',
      errOrigin: 'La solicitud fue rechazada. Recarga la página e inténtalo de nuevo.',
      errSetup: 'Suno aún no está configurado.',
      errBusy: 'Hay demasiados inicios de sesión en curso. Inténtalo más tarde.',
      errRedirect: 'Suno no devolvió una dirección de inicio de sesión válida.',
      errGeneric: 'La solicitud a Suno ha fallado.'
    }
  };
  const RETURN_KEY = 'oc-suno-return';
  const RETURN_MAX_MS = 15 * 60 * 1000;
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const lang = () => (typeof global.getLang === 'function' ? global.getLang() : 'de');
  const tr = (key) => (TEXTS[lang()] || TEXTS.de)[key] || TEXTS.de[key] || key;
  const access = () => global.OCAccess;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /* ---------- pure helpers ---------- */

  // The entry is for everybody who is signed in with an address; the server answers 401 to everybody else.
  function allowed(me) {
    return Boolean(me && me.active && me.identified && me.email);
  }

  // A readable sentence for a failed request. Known cases in the language of the page; otherwise the general sentence,
  // followed by what the server said (as text).
  function errorText(error) {
    if (!error || !error.status) return tr('errNetwork');
    if (error.status === 401) return tr('errLogin');
    if (error.status === 403) return tr('errOrigin');
    if (error.status === 503) return tr('errSetup');
    if (error.status === 429) return tr('errBusy');
    const detail = error.body && typeof error.body.error === 'string' ? error.body.error.trim().slice(0, 300) : '';
    return detail ? `${tr('errGeneric')} ${detail}` : tr('errGeneric');
  }

  // Only an https address without credentials is followed.
  function safeAuthorizationUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  /* ---------- state ---------- */

  const state = {
    attached: false,
    isOpen: false,
    busy: null, // 'load' | 'connect' | 'disconnect' | 'redirect'
    connected: null, // null until the server answered
    message: null, // { key } own text or { text } ready sentence, plus error
    confirming: false,
    confirmTimer: null,
    serial: 0, // answers of an earlier opening are ignored
    trigger: null,
    refs: null
  };

  function setMessage(message) {
    state.message = message || null;
  }

  function clearConfirm() {
    clearTimeout(state.confirmTimer);
    state.confirmTimer = null;
    state.confirming = false;
  }

  /* ---------- rendering ---------- */

  function build() {
    if (state.refs) return state.refs;
    const title = h('h2', { id: 'sunoTitle' });
    const closeButton = h('button', { id: 'sunoClose', class: 'modal-close', type: 'button', text: '×' });
    const intro = h('p', { class: 'settings-hint', id: 'sunoIntro' });
    const statusLabel = h('strong');
    const badge = h('span', { class: 'mcp-badge' });
    const hint = h('p', { class: 'settings-hint' });
    const feedback = h('div', { class: 'settings-feedback hidden', role: 'status', 'aria-live': 'polite' });
    const actions = h('div', { class: 'team-edit-actions' });
    const body = h('div', { id: 'sunoBody', class: 'modal-body mcp-body' }, intro, h('div', { class: 'mcp-key-head', id: 'sunoStatus' }, statusLabel, badge), hint, feedback, actions);
    const panel = h('div', { class: 'modal-panel mcp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sunoTitle', 'aria-describedby': 'sunoIntro', tabindex: '-1' }, h('div', { class: 'modal-head' }, title, closeButton), body);
    const modal = h('div', { id: 'sunoModal', class: 'modal hidden' }, panel);

    closeButton.addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    // Tab stays inside the dialog.
    modal.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null || node === document.activeElement);
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active) || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !state.isOpen) return;
      event.preventDefault();
      close();
    });
    document.body.append(modal);
    state.refs = { modal, panel, title, closeButton, intro, statusLabel, badge, hint, feedback, actions };
    return state.refs;
  }

  function button(label, { primary = false, danger = false, act } = {}) {
    const node = h('button', { type: 'button', class: `branding-manager-action${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, text: label });
    if (act) node.dataset.act = act;
    return node;
  }

  function render() {
    const refs = state.refs;
    if (!refs) return;
    // Keep the place of the focus when the buttons are rebuilt.
    const focusedAct = refs.actions.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    const hadFocus = refs.panel.contains(document.activeElement);

    refs.title.textContent = tr('title');
    refs.closeButton.title = tr('close');
    refs.closeButton.setAttribute('aria-label', tr('close'));
    refs.intro.textContent = tr('intro');
    refs.statusLabel.textContent = tr('status');

    const loading = state.busy === 'load';
    const known = state.connected !== null;
    refs.badge.className = `mcp-badge${known ? (state.connected ? ' is-status-active' : ' is-status-revoked') : ''}`;
    refs.badge.textContent = loading && !known ? tr('loading') : known ? tr(state.connected ? 'connected' : 'disconnected') : tr('unknown');
    refs.hint.textContent = known ? tr(state.connected ? 'connectedHint' : 'disconnectedHint') : '';
    refs.hint.classList.toggle('hidden', !known);

    const message = state.message;
    const text = message ? (message.key ? tr(message.key) : message.error ? errorText(message.error) : '') : '';
    refs.feedback.textContent = text;
    refs.feedback.classList.toggle('hidden', !text);
    refs.feedback.classList.toggle('error', Boolean(text && message.isError));

    const nodes = [];
    const busy = Boolean(state.busy);
    if (!known) {
      if (!loading) {
        const retry = button(tr('retry'), { primary: true, act: 'retry' });
        retry.addEventListener('click', () => load());
        nodes.push(retry);
      }
    } else if (state.connected) {
      const label = state.busy === 'disconnect' ? tr('disconnecting') : state.confirming ? tr('disconnectConfirm') : tr('disconnect');
      const disconnect = button(label, { danger: true, act: 'disconnect' });
      if (state.confirming) disconnect.classList.add('is-confirming');
      disconnect.disabled = busy;
      disconnect.addEventListener('click', onDisconnect);
      nodes.push(disconnect);
    } else {
      const label = state.busy === 'connect' || state.busy === 'redirect' ? tr('redirecting') : tr('connect');
      const connect = button(label, { primary: true, act: 'connect' });
      connect.disabled = busy;
      connect.addEventListener('click', onConnect);
      nodes.push(connect);
    }
    refs.actions.replaceChildren(...nodes);

    if (state.isOpen && hadFocus && !refs.panel.contains(document.activeElement)) {
      const next = (focusedAct && refs.actions.querySelector(`[data-act="${focusedAct}"]:not([disabled])`)) || refs.actions.querySelector('button:not([disabled])') || refs.closeButton;
      next.focus();
    }
  }

  /* ---------- actions ---------- */

  async function load() {
    if (state.busy) return;
    const serial = state.serial;
    state.busy = 'load';
    if (state.message && state.message.isError) setMessage(null);
    render();
    let result = null;
    let failure = null;
    try {
      result = await access().request('GET', '/api/suno/status');
    } catch (error) {
      failure = error;
    }
    if (serial !== state.serial) return;
    state.busy = null;
    if (failure) {
      state.connected = null;
      setMessage({ error: failure, isError: true });
    } else {
      state.connected = Boolean(result && result.connected);
    }
    render();
  }

  async function onConnect() {
    if (state.busy) return;
    const serial = state.serial;
    state.busy = 'connect';
    setMessage(null);
    render();
    let target = null;
    let failure = null;
    try {
      const result = await access().request('POST', '/api/suno/connect');
      target = safeAuthorizationUrl(result && result.authorizationUrl);
    } catch (error) {
      failure = error;
    }
    if (serial !== state.serial) return; // the dialog was closed meanwhile: no surprise redirect
    if (failure || !target) {
      state.busy = null;
      setMessage(failure ? { error: failure, isError: true } : { key: 'errRedirect', isError: true });
      render();
      return;
    }
    state.busy = 'redirect';
    render();
    try {
      global.sessionStorage.setItem(RETURN_KEY, String(Date.now()));
    } catch (_) {
      /* without storage the dialog simply does not reopen after the return */
    }
    global.location.assign(target);
  }

  // Two clicks: the first changes the button text, the second disconnects.
  async function onDisconnect() {
    if (state.busy) return;
    if (!state.confirming) {
      state.confirming = true;
      state.confirmTimer = setTimeout(() => {
        clearConfirm();
        render();
      }, 3500);
      render();
      return;
    }
    clearConfirm();
    const serial = state.serial;
    state.busy = 'disconnect';
    setMessage(null);
    render();
    let failure = null;
    try {
      await access().request('DELETE', '/api/suno/auth');
    } catch (error) {
      failure = error;
    }
    if (serial !== state.serial) return;
    state.busy = null;
    if (failure) {
      setMessage({ error: failure, isError: true });
    } else {
      state.connected = false;
      setMessage({ key: 'disconnectedDone' });
    }
    render();
  }

  /* ---------- the dialog ---------- */

  function open(trigger) {
    if (!access() || !allowed(access().me())) return;
    const refs = build();
    if (state.isOpen) return;
    const candidate = trigger && typeof trigger.focus === 'function' ? trigger : document.activeElement;
    state.trigger = candidate && candidate !== document.body ? candidate : null;
    state.serial += 1;
    state.isOpen = true;
    state.busy = null;
    state.connected = null;
    clearConfirm();
    setMessage(null);
    refs.modal.classList.remove('hidden');
    render();
    refs.closeButton.focus();
    load();
  }

  function close() {
    if (!state.refs || !state.isOpen) return;
    state.isOpen = false;
    state.serial += 1;
    state.busy = null;
    clearConfirm();
    setMessage(null);
    state.refs.modal.classList.add('hidden');
    const trigger = state.trigger;
    state.trigger = null;
    if (trigger && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus();
  }

  function rerender() {
    if (state.refs) render();
  }

  // The trigger of the menu that is on screen (chat and node view each have their own); the focus returns there.
  function visibleChip(variant) {
    const chips = [...document.querySelectorAll('.account-menu .account-chip')].filter((node) => node.offsetParent !== null);
    return chips.find((node) => variant && node.parentElement.dataset.variant === variant) || chips[0] || null;
  }

  // After the sign-in at Suno the person lands on the start page: show the result once.
  function resumeAfterReturn() {
    let startedAt = 0;
    try {
      startedAt = Number(global.sessionStorage.getItem(RETURN_KEY)) || 0;
      global.sessionStorage.removeItem(RETURN_KEY);
    } catch (_) {
      return;
    }
    if (!startedAt || Date.now() - startedAt > RETURN_MAX_MS) return;
    const ready = access() && access().ready;
    if (!ready || typeof ready.then !== 'function') return;
    ready.then(() => open(visibleChip())).catch(() => {});
  }

  // The menu entry "Suno": for everybody who is signed in.
  function attach() {
    if (state.attached || !global.OCShell) return;
    state.attached = true;
    global.OCShell.addSection('account', (ctx) => {
      if (!allowed(ctx.me)) return [];
      return [{ id: 'suno', label: tr('menu'), title: tr('menuTitle'), onSelect: () => open(visibleChip(ctx.variant)) }];
    });
    resumeAfterReturn();
  }

  global.OCSuno = { attach, open, close, rerender, helpers: { allowed, errorText, safeAuthorizationUrl } };
})(window);
