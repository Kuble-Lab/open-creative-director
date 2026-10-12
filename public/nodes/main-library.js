'use strict';

// Workflow import/export, templates, sharing, projects and chat bridge from main.js.
(function (global) {
  const OCD = global.OCDNodes;
  const runtime = OCD.main;
  const {
    ui, state, api, sharingFields, reloadListForTeams, navigate, updateListEntry, flushSave, loadList,
    lsGet, LS_LAST, lsSet, closeEvents, el, archiveUi, MAX_IMPORT_BYTES, graphLib, viewCenter, reserveId,
    applyGraph, setSelection, whenLayoutSettled, moveAppInput, openPalette, convertMotionHtml,
    updateChrome, closeWorkflow
  } = runtime;

  /* ---------- workflow operations ---------- */

  async function createWorkflow() {
    try {
      const base = ui.T('nodes.workflow.untitled');
      const names = new Set(state.workflows.map((workflow) => workflow.name));
      let name = base;
      for (let n = 2; names.has(name); n += 1) name = `${base} ${n}`;
      const payload = await api.createWorkflow({ name });
      state.workflows.unshift({ id: payload.workflow.id, name: payload.workflow.name, folder: payload.workflow.folder || null, updatedAt: payload.workflow.updatedAt, updatedBy: payload.workflow.updatedBy, nodeCount: 0, app: { enabled: false }, ...sharingFields(payload.workflow) });
      runtime.workflowList.setData({ workflows: state.workflows });
      reloadListForTeams();
      navigate(payload.workflow.id);
      setTimeout(() => {
        runtime.dom.name.focus();
        runtime.dom.name.select();
      }, 400);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.createFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function renameWorkflow(workflow) {
    const name = await ui.promptDialog({ title: ui.T('nodes.list.rename'), label: ui.T('nodes.workflow.name'), value: workflow.name, maxLength: 120 });
    if (name === null || !name || name === workflow.name) return;
    await patchName(workflow.id, name);
  }

  async function patchName(id, name) {
    try {
      const result = await api.patchWorkflow(id, { name });
      updateListEntry(id, { name: result.name });
      if (state.workflow && state.workflow.id === id) {
        state.workflow.name = result.name;
        runtime.dom.name.value = result.name;
      }
    } catch (error) {
      ui.toast(ui.T('nodes.toast.renameFailed', { error: error.message }), { kind: 'error' });
      if (state.workflow && state.workflow.id === id) runtime.dom.name.value = state.workflow.name;
    }
  }

  async function duplicateWorkflow(workflow) {
    try {
      if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
      const payload = await api.duplicateWorkflow(workflow.id);
      const created = payload.workflow || payload;
      await loadList();
      ui.toast(ui.T('nodes.toast.duplicated', { name: created.name || workflow.name }));
      navigate(created.id);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.duplicateFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function deleteWorkflow(workflow) {
    const confirmed = await ui.confirmDialog({
      title: ui.T('nodes.delete.title', { name: workflow.name }),
      message: ui.T('nodes.delete.message'),
      confirmLabel: ui.T('nodes.delete.confirm'),
      danger: true
    });
    if (!confirmed) return;
    try {
      const isCurrent = state.workflow && state.workflow.id === workflow.id;
      if (isCurrent) {
        clearTimeout(state.saveTimer);
        state.dirtyContent = false;
        state.dirtyViewport = false;
      }
      await api.deleteWorkflow(workflow.id);
      state.workflows = state.workflows.filter((item) => item.id !== workflow.id);
      runtime.workflowList.setData({ workflows: state.workflows });
      if (lsGet(LS_LAST) === workflow.id) lsSet(LS_LAST, null);
      ui.toast(ui.T('nodes.toast.deleted', { name: workflow.name }));
      if (isCurrent) {
        state.workflow = null;
        closeEvents();
        navigate('');
      }
    } catch (error) {
      ui.toast(error.status === 409 ? ui.T('nodes.toast.deleteBusy') : ui.T('nodes.toast.deleteFailed', { error: error.message }), { kind: 'error' });
    }
  }

  async function exportWorkflow(workflow) {
    if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
    const link = el('a', { href: api.exportUrl(workflow.id), download: '', class: 'hidden' });
    runtime.dom.overlays.append(link);
    link.click();
    link.remove();
  }

  // "Export with files (ZIP)": asks the size first (GET export-info). A ZIP that an import with the default limits
  // would refuse gets a dialog with the hint; the export itself stays possible. Otherwise a short note and the download.
  async function exportWorkflowZip(workflow) {
    if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
    let info;
    try {
      info = await api.exportInfo(workflow.id);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.exportFailed', { error: archiveUi.errorMessage(error) }), { kind: 'error' });
      return;
    }
    const note = archiveUi.exportNote(info);
    if (note.warnings.length) {
      const warnings = el('div', { class: 'nv-dialog-warnings' });
      for (const text of [...note.warnings, ui.T('nodes.export.stillPossible')]) warnings.append(el('p', { class: 'nv-dialog-message is-warn', text }));
      const confirmed = await ui.confirmDialog({
        title: ui.T('nodes.export.bigTitle'),
        message: note.line,
        confirmLabel: ui.T('nodes.export.downloadAnyway'),
        extra: warnings
      });
      if (!confirmed) return;
    } else {
      ui.toast(ui.T('nodes.export.starting', { info: note.line }));
    }
    const link = el('a', { href: api.exportZipUrl(workflow.id), download: '', class: 'hidden' });
    runtime.dom.overlays.append(link);
    link.click();
    link.remove();
  }

  let importing = false;

  // The note after an import: the name plus "x of y files imported" (a warning when files are missing).
  function reportImport(payload) {
    const name = ui.T('nodes.toast.imported', { name: payload.workflow.name });
    const files = archiveUi.filesFeedback(payload.files);
    if (!files) {
      ui.toast(name);
      return;
    }
    ui.toast(`${name} ${files.text}`, { kind: files.kind || undefined, timeout: files.kind ? 8000 : 5000 });
  }

  async function importZipFile(file) {
    if (file.size > archiveUi.MAX_ZIP_BYTES) {
      ui.toast(ui.T('nodes.toast.importFailed', { error: ui.T('nodes.import.tooLarge.archive', { limitMb: 500 }) }), { kind: 'error' });
      return;
    }
    const controller = new AbortController();
    const progress = archiveUi.createProgress({ host: runtime.dom.overlays, name: file.name, total: file.size, onCancel: () => controller.abort() });
    try {
      const payload = await api.importZip(file, {
        signal: controller.signal,
        onProgress: (ratio) => progress.update(ratio),
        onUploaded: () => progress.processing()
      });
      progress.close();
      await loadList();
      reportImport(payload);
      navigate(payload.workflow.id);
    } catch (error) {
      progress.close();
      ui.toast(error.aborted ? archiveUi.errorMessage(error) : ui.T('nodes.toast.importFailed', { error: archiveUi.errorMessage(error) }), { kind: error.aborted ? 'warn' : 'error' });
    }
  }

  async function importJsonFile(file) {
    if (file.size > MAX_IMPORT_BYTES) {
      ui.toast(ui.T('nodes.toast.importTooLarge'), { kind: 'error' });
      return;
    }
    let document;
    try {
      document = JSON.parse(await file.text());
    } catch (_) {
      ui.toast(ui.T('nodes.toast.importInvalid'), { kind: 'error' });
      return;
    }
    try {
      const payload = await api.importWorkflow(document);
      await loadList();
      reportImport(payload);
      navigate(payload.workflow.id);
    } catch (error) {
      ui.toast(ui.T('nodes.toast.importFailed', { error: archiveUi.errorMessage(error) }), { kind: 'error' });
    }
  }

  // "Import" takes .json (the workflow only) and .zip (with files); the kind comes from the extension and the content.
  async function importFile(file) {
    if (importing) {
      ui.toast(ui.T('nodes.import.busy'), { kind: 'warn' });
      return;
    }
    importing = true;
    try {
      if ((await archiveUi.detectKind(file)) === 'zip') await importZipFile(file);
      else await importJsonFile(file);
    } finally {
      importing = false;
    }
  }

  /* ---------- templates, projects, chat bridge (WP7) ---------- */

  function currentLang() {
    return typeof global.getLang === 'function' ? global.getLang() : 'en';
  }

  async function loadFolders() {
    try {
      const payload = await api.request('GET', '/api/folders');
      return (payload.folders || []).map((folder) => folder.name).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function projectSelect(folders, value) {
    const select = el('select', { class: 'nv-input nv-select', 'aria-label': ui.T('nodes.project.label') });
    select.append(el('option', { value: '', text: ui.T('nodes.project.none') }));
    const names = value && !folders.includes(value) ? [value, ...folders] : folders;
    for (const name of names) select.append(el('option', { value: name, text: name }));
    select.value = value || '';
    return select;
  }

  // Starter templates (public/nodes/templates-ui.js): list and documents, cached for a few minutes.
  const templateStore = OCD.templatesUi.createStore({ api, getLang: () => currentLang() });

  // Translated name of a node type, for the reading line and the search of a template.
  function typeLabelOf(type) {
    const def = state.reg && state.reg.types.get(type);
    return def ? ui.typeLabel(def) : type;
  }

  // Help of the node types (public/nodes/node-help.js): palette, quick pick, card popover and inspector section.
  const nodeHelp = OCD.nodeHelp.createHelp({
    getReg: () => state.reg,
    templates: () => templateStore,
    canInsert: canInsertNow,
    insertWithInputs,
    insertTemplate: (template) => insertTemplate(template)
  });

  // The gallery of the starter templates. "New workflow" creates one from the template (as before); "Insert into this
  // workflow" puts it into the open workflow (only offered with one open). options.primary: 'insert' makes the latter the
  // main button (the empty canvas), 'new' the former (the workflow list).
  async function openTemplateDialog(options = {}) {
    let templates;
    try {
      templates = await templateStore.list({ refresh: true });
    } catch (error) {
      ui.toast(ui.T('nodes.template.loadFailed', { error: error.message }), { kind: 'error' });
      return;
    }
    const folders = await loadFolders();
    const canInsert = canInsertNow();
    const choice = await OCD.templatesUi.openGallery({
      templates,
      labelOf: typeLabelOf,
      canInsert,
      primary: options && options.primary === 'insert' ? 'insert' : 'new',
      select: projectSelect(folders, '')
    });
    if (!choice) return;
    if (choice.action === 'insert') {
      await insertTemplate(choice.template);
      return;
    }
    try {
      const payload = await api.createWorkflow({ templateId: choice.template.id, lang: currentLang(), folder: choice.folder });
      state.workflows.unshift({
        id: payload.workflow.id,
        name: payload.workflow.name,
        folder: payload.workflow.folder || null,
        updatedAt: payload.workflow.updatedAt,
        updatedBy: payload.workflow.updatedBy,
        nodeCount: payload.workflow.graph.nodes.length,
        app: { enabled: Boolean(payload.workflow.app && payload.workflow.app.enabled) },
        ...sharingFields(payload.workflow)
      });
      runtime.workflowList.setData({ workflows: state.workflows });
      reloadListForTeams();
      navigate(payload.workflow.id);
    } catch (error) {
      ui.toast(ui.T('nodes.template.createFailed', { error: error.message }), { kind: 'error' });
    }
  }

  // Is there an open workflow that can take new nodes right now?
  function canInsertNow() {
    return Boolean(state.workflow && state.reg && runtime.canvas);
  }

  // Puts a sub graph ({ nodes, edges, notes, groups }) into the open workflow as ONE undo step: new ids, a free place
  // (right of the existing content, the middle of the view on an empty canvas), the new items selected and in view.
  // Nothing is run. options: { history: undo label, at, avoid } as for graphLib.insertSubgraph. Returns its result
  // ({ ids, idMap, bounds, skippedLinks }) or null (with a toast) when nothing could be inserted. Templates, "insert with
  // inputs" and the assistant all come through here. sub.links (the assistant) connect new nodes and existing ones; they
  // are checked against the graph as it is now and never replace a connection (graphLib.insertSubgraph).
  function insertSubgraph(sub, options = {}) {
    if (!canInsertNow()) return null;
    const { history, ...placement } = options;
    const result = graphLib.insertSubgraph(state.graph, sub, { reg: state.reg, sizes: runtime.canvas.getSizes(), reserved: state.reserved, center: viewCenter(), ...placement });
    if (result.error) {
      ui.toast(ui.T(`nodes.insert.${result.error.reason}`, { type: result.error.type || '' }), { kind: 'warn' });
      return null;
    }
    for (const id of result.ids.nodes) reserveId(id);
    for (const id of result.ids.edges || []) reserveId(id);
    applyGraph(result.graph, { history: history || 'insert' });
    // only connections between existing nodes (sub.links without new items): the selection stays as it is
    if (result.ids.nodes.length || result.ids.notes.length || result.ids.groups.length) {
      setSelection({ nodes: result.ids.nodes, notes: result.ids.notes, groups: result.ids.groups, edge: null });
      revealBounds(result.bounds);
    }
    return result;
  }

  // Brings a world rectangle into view: nothing moves when it is already there, otherwise the view fits the whole graph
  // (old and new content), never zoomed in beyond 100 %. Waits for the cards to be measured and the panels to settle.
  function revealBounds(bounds) {
    whenLayoutSettled(() => {
      if (!runtime.canvas || !bounds) return;
      const size = runtime.canvas.containerSize();
      const view = runtime.canvas.getViewport();
      const topLeft = graphLib.worldToScreen(view, bounds.x, bounds.y);
      const margin = 24;
      const inside = topLeft.x >= margin && topLeft.y >= margin && topLeft.x + bounds.w * view.zoom <= size.width - margin && topLeft.y + bounds.h * view.zoom <= size.height - margin;
      if (!inside) runtime.canvas.fit({ padding: 96 });
    });
  }

  // The nodes of an insertion by the assistant, selected and in view.
  function showNodes(ids) {
    if (!canInsertNow() || !ids.length) return;
    setSelection({ nodes: ids, notes: [], groups: [], edge: null });
    revealBounds(graphLib.boundsOf(state.graph, runtime.canvas.getSizes(), { nodes: ids }));
  }

  // What the plan of the engine complains about (the assistant gets it as data to explain what is missing).
  function assistantWarnings() {
    const plan = runtime.runController ? runtime.runController.getPlan() : null;
    return ((plan && plan.issues) || []).filter((issue) => issue && typeof issue.message === 'string').map((issue) => ({ node: issue.nodeId || undefined, message: issue.message }));
  }

  // The assistant opened or closed (assistant-ui.js onToggle). Closing with Escape brings the focus back to its button.
  function setAssistantOpen(open, options = {}) {
    if (!runtime.dom) return;
    runtime.dom.body.classList.toggle('assistant-open', open);
    runtime.dom.root.classList.toggle('has-assistant', open);
    runtime.dom.assistantBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    runtime.dom.assistantBtn.classList.toggle('is-active', open);
    if (!open && options.focus) runtime.dom.assistantBtn.focus({ preventScroll: true });
    setTimeout(() => runtime.canvas && runtime.canvas.relayout(), 220);
  }

  // Inserts a starter template into the open workflow (the app section of the template is not taken over).
  async function insertTemplate(template) {
    if (!canInsertNow()) return null;
    const workflowId = state.workflow.id;
    let document;
    try {
      document = await templateStore.document(template.id);
    } catch (error) {
      ui.toast(ui.T('nodes.template.insertFailed', { error: error.message }), { kind: 'error' });
      return null;
    }
    // another workflow may have been opened while the document loaded
    if (!state.workflow || state.workflow.id !== workflowId) return null;
    const result = insertSubgraph(document.graph, { history: 'insert-template' });
    if (result) ui.toast(ui.T('nodes.template.inserted', { name: document.name || template.name }));
    return result;
  }

  // Puts a node of `type` into the open workflow with a node in front of each required input (the input node of its
  // kind, or the node the input's `suggest` hint names), connected, as ONE undo step. Nothing is run.
  // options: { params, world }: with a point the node itself lands there, otherwise the block goes beside the content.
  function insertWithInputs(type, options = {}) {
    if (!canInsertNow()) return null;
    const built = graphLib.inputsSubgraph(state.reg, type, { params: options.params });
    if (built.error) {
      ui.toast(ui.T(`nodes.insert.${built.error.reason}`, { type }), { kind: 'warn' });
      return null;
    }
    const placement = {};
    if (options.world && Number.isFinite(options.world.x) && Number.isFinite(options.world.y)) {
      const left = Math.min(...built.nodes.map((node) => node.x));
      const top = Math.min(...built.nodes.map((node) => node.y));
      placement.at = { x: graphLib.snap(options.world.x + left, 8), y: graphLib.snap(options.world.y + top, 8) };
      placement.avoid = true;
    }
    const result = insertSubgraph({ nodes: built.nodes, edges: built.edges }, { history: 'insert-with-inputs', ...placement });
    if (result) ui.toast(ui.T('nodes.help.insertedWithInputs', { name: typeLabelOf(type), count: result.ids.nodes.length }));
    return result;
  }

  // Fix of an incomplete card, "Put <node> in front": the node named by the `suggest` hint of the missing input goes in
  // front of it, connected, with its own required inputs supplied as well (Motion HTML writer <- Prompt) and the assets
  // the node already has handed on to it. One undo step; nothing is run (a paid node asks before the run).
  function addInputFor(nodeId, portId) {
    if (!canInsertNow() || !portId) return;
    const result = graphLib.addInputSources(state.reg, state.graph, nodeId, { ports: [portId], sizes: runtime.canvas.getSizes(), reserved: state.reserved });
    if (result.error) {
      ui.toast(ui.T('nodes.fix.failed'), { kind: 'warn' });
      return;
    }
    for (const node of result.nodes) reserveId(node.id);
    for (const edge of result.edges) reserveId(edge.id);
    // A field shared in the Design App (the HTML field, say) is driven by a connection now: share the new Prompt node's
    // text instead, with the same label (as the conversion of free text does).
    const target = graphLib.getNode(state.graph, nodeId);
    const port = target ? graphLib.findPort(state.reg, target, 'in', portId) : null;
    const prompt = result.nodes.find((node) => node.type === graphLib.PROMPT_TYPE);
    if (port && port.param && prompt && moveAppInput({ node: nodeId, param: port.param }, { node: prompt.id, param: 'prompt' })) {
      state.appRemaps.push({ from: { node: nodeId, param: port.param }, to: { node: prompt.id, param: 'prompt' } });
      if (state.appRemaps.length > 50) state.appRemaps.shift();
    }
    applyGraph(result.graph, { history: 'add-input' });
    const ids = result.nodes.map((node) => node.id);
    setSelection({ nodes: ids, notes: [], groups: [], edge: null });
    revealBounds(graphLib.boundsOf(result.graph, runtime.canvas.getSizes(), { nodes: [nodeId, ...ids] }));
    const supplied = result.supplied[0] ? result.nodes.find((node) => node.id === result.supplied[0].node) : null;
    ui.toast(ui.T('nodes.fix.added', { name: supplied ? typeLabelOf(supplied.type) : '' }));
  }

  // Fix of an incomplete card, "Choose a suitable node …": the quick pick for exactly this input, as when dragging from its
  // port; a node named by the hint of the input is on top.
  function pickInputFor(nodeId, portId) {
    if (!canInsertNow()) return;
    const node = graphLib.getNode(state.graph, nodeId);
    const port = node ? graphLib.findPort(state.reg, node, 'in', portId) : null;
    if (!port) return;
    openPalette(
      { world: { x: node.x - 56, y: node.y + 20 }, anchor: { dir: 'in', node: nodeId, port: portId }, exact: true },
      { dir: 'in', type: port.type, multiple: port.multiple === true, prefer: port.suggest }
    );
  }

  // The buttons of a card or of the inspector that remove the cause of an "Incomplete" status in one step.
  // Selects a node and brings it into view (the line about the song length of "Generate music" leads to its song text).
  function selectNodeById(nodeId) {
    const node = graphLib.getNode(state.graph, nodeId);
    if (!node) return;
    setSelection({ nodes: [nodeId], notes: [], groups: [], edge: null });
    runtime.canvas.centerOnWorld(node.x + 148, node.y + 60);
  }

  function applyFix(nodeId, fixId, fix) {
    if (fixId === 'motion-html') convertMotionHtml(nodeId);
    else if (fixId === 'add-input') addInputFor(nodeId, fix && fix.port);
    else if (fixId === 'pick-input') pickInputFor(nodeId, fix && fix.port);
  }

  // Assigns a workflow to a project (chat folder) or removes the assignment.
  /* ---------- user management: sharing and lost access ---------- */

  // Private and owned: other people cannot open the workflow (or its Design App link) before it is shared.
  function isPrivateOwned(workflow) {
    const access = global.OCAccess;
    return Boolean(access && access.isActive() && workflow && workflow.unowned === false && workflow.shareMode === 'private');
  }

  async function openShareDialog(target) {
    const access = global.OCAccess;
    const workflow = target && typeof target.id === 'string' ? target : state.workflow;
    if (!workflow || !access || !access.isActive()) return;
    // The open workflow carries fresher fields than its list entry.
    const entry = state.workflow && state.workflow.id === workflow.id ? state.workflow : workflow;
    // Like the chat dialog: the people to pick and, where the account may share with teams, the teams to offer.
    let members;
    let teams;
    try {
      [members, teams] = await Promise.all([
        access.loadTeam({ refresh: true }),
        access.allowedModes().includes('teams') ? access.loadOwnTeams({ refresh: true }) : []
      ]);
    } catch (error) {
      ui.toast(global.t('sharing.loadFailed', { error: error.message }), { kind: 'error' });
      return;
    }
    const form = access.shareForm({ entry, members, teams });
    const feedback = el('div', { class: 'share-feedback hidden', role: 'alert' });
    const body = el('div', { class: 'nv-share' }, el('p', { class: 'nv-dialog-message', text: global.t('sharing.hint') }), form.element, feedback);
    let saving = false;
    const save = async (finish) => {
      if (saving) return;
      saving = true;
      feedback.classList.add('hidden');
      try {
        finish({ fields: await access.saveSharing('workflow', workflow.id, form.read()) });
      } catch (error) {
        if (error.gone) {
          finish({ gone: true });
          return;
        }
        feedback.textContent = error.userMessage || error.message;
        feedback.classList.remove('hidden');
        if (error.reloadTeam) access.loadTeam({ refresh: true }).catch(() => {});
        if (error.reloadTeams) access.loadOwnTeams({ refresh: true }).catch(() => {});
      } finally {
        saving = false;
      }
    };
    const result = await ui.dialog({
      title: global.t('sharing.titleWorkflow'),
      body,
      width: 460,
      buttons: [
        { label: ui.T('nodes.common.cancel'), value: null, cancel: true },
        {
          label: global.t('sharing.save'),
          value: null,
          primary: true,
          onClick: (finish) => {
            save(finish);
            return false;
          }
        }
      ],
      onOpen: () => form.focus()
    });
    if (!result) return;
    if (result.gone) {
      ui.toast(global.t('sharing.gone'), { kind: 'warn' });
      if (state.workflow && state.workflow.id === workflow.id) await handleAccessLost();
      else loadList();
      return;
    }
    updateListEntry(workflow.id, result.fields);
    if (state.workflow && state.workflow.id === workflow.id) {
      Object.assign(state.workflow, result.fields);
      updateChrome();
    }
    ui.toast(global.t('sharing.saved'));
  }

  // The owner can take the sharing back at any time: the open workflow then answers 404. Leave it quietly.
  async function handleAccessLost() {
    if (!state.workflow) return;
    ui.toast(ui.T('nodes.access.lost'), { kind: 'warn', timeout: 7000 });
    // Nothing can be saved any more, so there is nothing to keep.
    state.dirtyContent = false;
    state.dirtyViewport = false;
    await closeWorkflow();
    lsSet(LS_LAST, null);
    navigate('');
    loadList();
  }

  let accessCheckAt = 0;

  // After a stream error (or when the window comes back) a plain read tells whether the workflow is still ours.
  async function checkStillAccessible() {
    const access = global.OCAccess;
    if (!access || !access.isActive() || !state.workflow || !state.active) return;
    const now = Date.now();
    if (now - accessCheckAt < 3000) return;
    accessCheckAt = now;
    const id = state.workflow.id;
    try {
      await api.getWorkflow(id);
    } catch (error) {
      if (error.status === 404 && state.workflow && state.workflow.id === id) handleAccessLost();
    }
  }

  async function assignProject(workflow) {
    const folders = await loadFolders();
    const select = projectSelect(folders, workflow.folder || '');
    const result = await ui.dialog({
      title: ui.T('nodes.project.title', { name: workflow.name }),
      message: ui.T('nodes.project.message'),
      body: el('div', { class: 'nv-dialog-field' }, el('label', { class: 'nv-field-label', text: ui.T('nodes.project.label') }), select),
      buttons: [
        { label: ui.T('nodes.common.cancel'), value: false, cancel: true },
        { label: ui.T('nodes.common.save'), value: true, primary: true }
      ],
      onOpen: () => select.focus()
    });
    if (!result) return;
    const folder = select.value || null;
    if (folder === (workflow.folder || null)) return;
    try {
      const patched = await api.patchWorkflow(workflow.id, { folder });
      updateListEntry(workflow.id, { folder: patched.folder || null });
      if (state.workflow && state.workflow.id === workflow.id) state.workflow.folder = patched.folder || null;
      workflow.folder = patched.folder || null;
      ui.toast(folder ? ui.T('nodes.project.assigned', { project: folder }) : ui.T('nodes.project.removed'));
    } catch (error) {
      ui.toast(ui.T('nodes.project.failed', { error: error.message }), { kind: 'error' });
    }
  }

  async function openWorkflowApp(workflow) {
    if (state.workflow && state.workflow.id === workflow.id) await flushSave().catch(() => {});
    global.location.hash = `#app=${encodeURIComponent(workflow.id)}`;
  }

  function hasNodeResult(nodeId) {
    const entry = state.results && state.results.nodes && state.results.nodes[nodeId];
    return Boolean(entry && entry.selected && entry.selected.entry);
  }

  // Sends the selected result of a node to a chat (asks which one).
  function sendNodeToChat(nodeId) {
    if (!state.workflow || !OCD.assetPicker) return Promise.resolve(null);
    if (!hasNodeResult(nodeId)) {
      ui.toast(ui.T('nodes.run.noResult'), { kind: 'warn' });
      return Promise.resolve(null);
    }
    return OCD.assetPicker.sendToChat({ workflowId: state.workflow.id, nodeId });
  }

  function openImportPicker() {
    const input = el('input', { type: 'file', accept: archiveUi.IMPORT_ACCEPT, class: 'hidden' });
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) importFile(input.files[0]);
      input.remove();
    });
    runtime.dom.overlays.append(input);
    input.click();
  }


  Object.assign(runtime, {
    createWorkflow, renameWorkflow, patchName, duplicateWorkflow, deleteWorkflow, exportWorkflow,
    exportWorkflowZip, reportImport, importZipFile, importJsonFile, importFile, currentLang, loadFolders,
    projectSelect, templateStore, typeLabelOf, nodeHelp, openTemplateDialog, canInsertNow,
    insertSubgraph, revealBounds, showNodes, assistantWarnings, setAssistantOpen, insertTemplate,
    insertWithInputs, addInputFor, pickInputFor, selectNodeById, applyFix, isPrivateOwned,
    openShareDialog, handleAccessLost, checkStillAccessible, assignProject, openWorkflowApp,
    hasNodeResult, sendNodeToChat, openImportPicker
  });
})(window);
