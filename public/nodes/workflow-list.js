'use strict';

// Left drawer of the node view: workflow list with search, new, import and a per-item menu
// (rename, duplicate, export, delete). With user management (AUTH_WHOAMI_URL) the server only lists what the person
// may see; a badge shows shared workflows and the owner of somebody else's workflow. Admins can switch the list to
// "Teams" (public/team-groups.js): one group per team, the server sends every workflow with its team.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});
  const ui = OCD.ui;
  const api = OCD.api;
  const { el } = ui;

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

  function createWorkflowList({ host, callbacks }) {
    const cb = callbacks || {};
    let data = { workflows: [], activeId: null, loading: true, error: null };
    let query = '';

    const head = el('div', { class: 'nv-drawer-head' });
    const title = el('h2', { class: 'nv-drawer-title', text: ui.T('nodes.list.title') });
    const newButton = el('button', { type: 'button', class: 'nv-btn nv-btn-primary nv-btn-sm nv-new-workflow' }, ui.icon('plus', 14), el('span', { text: ui.T('nodes.list.new') }));
    newButton.addEventListener('click', () => cb.onCreate && cb.onCreate());
    head.append(title, newButton);
    const search = el('input', { class: 'nv-input nv-drawer-search', type: 'search', placeholder: ui.T('nodes.list.search'), 'aria-label': ui.T('nodes.list.search'), autocomplete: 'off' });
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      renderItems();
    });
    // "Projects | Teams" (admins only); the list is grouped on the client from the team the server sends with each workflow.
    const teams = global.OCTeamGroups || null;
    const grouping = teams ? teams.switcher({ view: 'workflows', onChange: () => renderItems() }) : null;
    if (grouping) grouping.element.classList.add('nv-drawer-grouping');
    const items = el('div', { class: 'nv-drawer-items', role: 'list' });
    const importInput = el('input', { type: 'file', accept: '.json,application/json', class: 'nv-file-input', tabindex: '-1' });
    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = '';
      if (file && cb.onImport) cb.onImport(file);
    });
    const importButton = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-import' }, ui.icon('upload', 14), el('span', { text: ui.T('nodes.list.import') }));
    importButton.addEventListener('click', () => importInput.click());
    const templateButton = el('button', { type: 'button', class: 'nv-btn nv-btn-sm nv-from-template' }, ui.icon('template', 14), el('span', { text: ui.T('nodes.template.new') }));
    templateButton.addEventListener('click', () => cb.onTemplate && cb.onTemplate());
    const foot = el('div', { class: 'nv-drawer-foot' }, templateButton, importButton, importInput);
    host.append(head, search, ...(grouping ? [grouping.element] : []), items, foot);

    function menuFor(workflow, x, y) {
      const manage = workflow.canManage !== false;
      ui.menu(x, y, [
        { label: ui.T('nodes.list.open'), icon: 'workflow', onClick: () => cb.onOpen && cb.onOpen(workflow.id) },
        { label: ui.T('nodes.list.openApp'), icon: 'external', disabled: !(workflow.app && workflow.app.enabled), onClick: () => cb.onOpenApp && cb.onOpenApp(workflow) },
        manage && { label: ui.T('nodes.list.rename'), icon: 'edit', onClick: () => cb.onRename && cb.onRename(workflow) },
        { label: ui.T('nodes.list.duplicate'), icon: 'duplicate', onClick: () => cb.onDuplicate && cb.onDuplicate(workflow) },
        { label: ui.T('nodes.list.export'), icon: 'download', onClick: () => cb.onExport && cb.onExport(workflow) },
        manage && { label: ui.T('nodes.project.assign'), icon: 'folder', onClick: () => cb.onProject && cb.onProject(workflow) },
        workflow.canShare === true && { label: ui.T('nodes.share.menu'), icon: 'users', onClick: () => cb.onShare && cb.onShare(workflow) },
        manage && { separator: true },
        manage && { label: ui.T('nodes.list.delete'), icon: 'trash', danger: true, onClick: () => cb.onDelete && cb.onDelete(workflow) }
      ].filter(Boolean));
    }

    // The list is built anew after every change; the keyboard focus (a group head) is put back afterwards.
    function renderItems() {
      const rebuild = () => buildItems();
      if (teams) teams.preserveFocus(items, rebuild);
      else rebuild();
    }

    function buildItems() {
      items.textContent = '';
      // The groups are sections with a list each; only the flat list (project view, search) is a list of rows itself.
      const grouped = Boolean(teams) && teams.mode('workflows') === 'teams' && !query;
      if (grouped) items.removeAttribute('role');
      else items.setAttribute('role', 'list');
      if (data.loading) {
        items.append(el('div', { class: 'nv-drawer-note', text: ui.T('nodes.list.loading') }));
        return;
      }
      if (data.error) {
        const retry = el('button', { type: 'button', class: 'nv-btn nv-btn-sm', text: ui.T('nodes.common.retry') });
        retry.addEventListener('click', () => cb.onReload && cb.onReload());
        items.append(el('div', { class: 'nv-drawer-note is-error' }, el('div', { text: ui.T('nodes.list.loadError', { error: data.error }) }), retry));
        return;
      }
      const filtered = data.workflows.filter((workflow) => !query || `${workflow.name} ${workflow.folder || ''}`.toLowerCase().includes(query));
      if (!filtered.length) {
        items.append(el('div', { class: 'nv-drawer-note', text: data.workflows.length ? ui.T('nodes.list.noMatch') : ui.T('nodes.list.empty') }));
        return;
      }
      const teamsMode = Boolean(teams) && teams.mode('workflows') === 'teams';
      if (grouped) {
        for (const group of teams.groupWorkflows(filtered, data.teamGroups)) items.append(groupNode(group));
        return;
      }
      // A hit of the search in the team view names its team.
      for (const workflow of filtered) items.append(workflowRow(workflow, { showTeam: teamsMode }));
    }

    function groupNode(group) {
      const open = teams.isOpen('workflows', group);
      const section = el('section', { class: `nv-wf-group${group.archived ? ' is-archived' : ''}`, dataset: { team: group.id } });
      const nameLine = el('span', { class: 'nv-wf-group-nameline' }, el('span', { class: 'nv-wf-group-name', text: teams.label(group), title: teams.label(group) }));
      if (group.archived) nameLine.append(el('span', { class: 'nv-wf-group-flag', text: ui.T('teamGroups.archived') }));
      const header = el(
        'button',
        { type: 'button', class: 'nv-wf-group-head', 'aria-expanded': String(open), dataset: { teamId: group.id, focusKey: `team:${group.id}` } },
        el('span', { class: 'nv-wf-group-chevron', 'aria-hidden': 'true', text: open ? '⌄' : '›' }),
        el('span', { class: 'nv-wf-group-text' }, nameLine, el('span', { class: 'nv-wf-group-meta', text: teams.counts(group, 'workflows') }))
      );
      header.addEventListener('click', () => {
        teams.setOpen('workflows', group.id, !open);
        renderItems();
      });
      section.append(header);
      if (open) {
        const body = el('div', { class: 'nv-wf-group-items', role: 'list' });
        for (const workflow of group.workflows) body.append(workflowRow(workflow, { teamGroup: true }));
        section.append(body);
      }
      return section;
    }

    function workflowRow(workflow, { teamGroup = false, showTeam = false } = {}) {
      const active = workflow.id === data.activeId;
      const row = el('div', { class: `nv-wf-item ${active ? 'is-active' : ''}`.trim(), role: 'listitem', dataset: { id: workflow.id } });
      const open = el('button', { type: 'button', class: 'nv-wf-open', 'aria-current': active ? 'true' : null });
      const thumb = el('span', { class: 'nv-wf-thumb' });
      if (workflow.thumbnail) thumb.append(el('img', { src: api.rel(workflow.thumbnail), alt: '', loading: 'lazy', draggable: 'false' }));
      else thumb.append(ui.icon('workflow', 16));
      const text = el('span', { class: 'nv-wf-text' });
      const nameLine = el('span', { class: 'nv-wf-nameline' }, el('span', { class: 'nv-wf-name', text: workflow.name }));
      if (workflow.app && workflow.app.enabled) nameLine.append(el('span', { class: 'nv-badge is-app', title: ui.T('nodes.list.appBadgeHint'), text: ui.T('nodes.app.badge') }));
      // User management: shared badge (team / number of people); nothing for private and for existing workflows.
      const shared = global.OCAccess ? global.OCAccess.badge(workflow) : null;
      if (shared) nameLine.append(el('span', { class: 'nv-badge is-shared', title: shared.title, text: shared.label }));
      text.append(nameLine);
      const meta = [ui.T('nodes.list.nodeCount', { count: workflow.nodeCount }), formatDate(workflow.updatedAt)];
      if (workflow.updatedBy) meta.push(workflow.updatedBy);
      text.append(el('span', { class: 'nv-wf-meta', text: meta.filter(Boolean).join(' · ') }));
      if (workflow.folder) text.append(el('span', { class: 'nv-wf-folder', text: workflow.folder }));
      // In a group of the team view every workflow names its owner (own ones too); otherwise only somebody else's.
      const foreign = teamGroup
        ? teams.ownerLabel(workflow.owner) || { text: ui.T('teamGroups.noOwner'), title: ui.T('teamGroups.noOwner') }
        : global.OCAccess ? global.OCAccess.ownerName(workflow) : null;
      if (foreign) text.append(el('span', { class: 'nv-wf-owner', title: foreign.title, text: foreign.text }));
      if (showTeam) {
        const teamName = teams.label(workflow.team ? { name: workflow.team.name, id: workflow.team.id } : { internal: true });
        text.append(el('span', { class: 'nv-wf-team', title: ui.T('teamGroups.teamTitle', { name: teamName }), text: teamName }));
      }
      open.append(thumb, text);
      open.addEventListener('click', () => cb.onOpen && cb.onOpen(workflow.id));
      const more = el('button', { type: 'button', class: 'nv-icon-btn nv-wf-more', title: ui.T('nodes.list.actions'), 'aria-label': ui.T('nodes.list.actions') }, ui.icon('more', 16));
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = more.getBoundingClientRect();
        menuFor(workflow, rect.left, rect.bottom + 4);
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        menuFor(workflow, event.clientX, event.clientY);
      });
      row.append(open, more);
      return row;
    }

    function setData(next) {
      data = { ...data, ...next };
      if (grouping) grouping.refresh();
      renderItems();
    }

    function relabel() {
      title.textContent = ui.T('nodes.list.title');
      newButton.querySelector('span').textContent = ui.T('nodes.list.new');
      search.placeholder = ui.T('nodes.list.search');
      search.setAttribute('aria-label', ui.T('nodes.list.search'));
      importButton.querySelector('span').textContent = ui.T('nodes.list.import');
      templateButton.querySelector('span').textContent = ui.T('nodes.template.new');
      if (grouping) grouping.refresh();
      renderItems();
    }

    renderItems();
    return { setData, relabel, focusSearch: () => search.focus() };
  }

  OCD.workflowList = { createWorkflowList };
})(window);
