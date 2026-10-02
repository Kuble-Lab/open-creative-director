'use strict';

// REST + SSE helpers of the node view (SPEC §11). Own request() with the same error shape as
// app.js api(): Error with `status`, plus `code`, `rev`, `runId`, `issues` when the server sends them.
(function (global) {
  const OCD = (global.OCDNodes = global.OCDNodes || {});

  function rel(path) {
    return String(path).replace(/^\/+/, '');
  }

  async function request(method, path, body, options = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (options.keepalive) init.keepalive = true;
    const res = await fetch(rel(path), init);
    if (!res.ok) throw await toError(res);
    return res.status === 204 ? null : res.json();
  }

  async function toError(res) {
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      /* not JSON */
    }
    const error = new Error(payload?.error || `HTTP ${res.status}`);
    error.status = res.status;
    if (payload) {
      error.code = payload.code;
      error.rev = payload.rev;
      error.runId = payload.runId;
      error.issues = payload.issues;
      error.reason = payload.reason;
      error.params = payload.params;
      error.body = payload;
    }
    return error;
  }

  const enc = encodeURIComponent;

  // Raw body with progress (XMLHttpRequest, the only way to get upload progress). options: { headers, onProgress(ratio),
  // onUploaded(), signal }. Resolves the JSON answer; errors carry status, code, reason and params like request().
  function rawPost(path, file, options = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', rel(path));
      for (const [name, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (options.onProgress && event.lengthComputable) options.onProgress(event.loaded / event.total);
      };
      xhr.upload.onload = () => options.onUploaded && options.onUploaded();
      xhr.onerror = () => reject(Object.assign(new Error('Network error'), { status: 0 }));
      xhr.onabort = () => reject(Object.assign(new Error('Aborted'), { status: 0, aborted: true }));
      xhr.onload = () => {
        let payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch (_) {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload) {
          resolve(payload);
          return;
        }
        const error = new Error(payload?.error || `HTTP ${xhr.status}`);
        error.status = xhr.status;
        error.code = payload?.code;
        error.reason = payload?.reason;
        error.params = payload?.params;
        reject(error);
      };
      if (options.signal) options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  }

  // Raw upload with progress. Resolves { value } (or { value, rasterized }) of POST /uploads.
  function upload(workflowId, file, options = {}) {
    const query = options.accept ? `?accept=${enc(options.accept)}` : '';
    return rawPost(`/api/workflows/${enc(workflowId)}/uploads${query}`, file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': enc(file.name || 'upload') },
      onProgress: options.onProgress,
      signal: options.signal
    });
  }

  // Import of an export ZIP (POST /import-zip): the raw ZIP as body. Resolves { workflow, results, files }.
  function importZip(file, options = {}) {
    return rawPost('/api/workflows/import-zip', file, {
      headers: { 'Content-Type': 'application/zip' },
      onProgress: options.onProgress,
      onUploaded: options.onUploaded,
      signal: options.signal
    });
  }

  // EventSource wrapper: handlers = { onEvent(event), onOpen(), onError() }. Returns { close() }.
  // The browser reconnects on its own; callers reconcile through GET /api/workflows/:id afterwards.
  function openEvents(workflowId, handlers = {}) {
    if (typeof EventSource === 'undefined') return { close() {} };
    const source = new EventSource(rel(`/api/workflows/${enc(workflowId)}/events`));
    source.onmessage = (message) => {
      let event = null;
      try {
        event = JSON.parse(message.data);
      } catch (_) {
        return;
      }
      if (event && handlers.onEvent) handlers.onEvent(event);
    };
    source.onopen = () => handlers.onOpen && handlers.onOpen();
    source.onerror = () => handlers.onError && handlers.onError();
    return { close: () => source.close() };
  }

  OCD.api = {
    rel,
    request,
    upload,
    importZip,
    openEvents,
    registry: () => request('GET', '/api/nodes/registry'),
    options: (source) => request('GET', `/api/nodes/options/${enc(source)}`),
    higgsfieldModel: (id) => request('GET', `/api/nodes/higgsfield-models/${enc(id)}`),
    config: () => request('GET', '/api/config'),
    templates: (lang) => request('GET', `/api/workflow-templates?lang=${enc(lang)}`),
    template: (id, lang) => request('GET', `/api/workflow-templates/${enc(id)}?lang=${enc(lang)}`),
    listWorkflows: (q) => request('GET', `/api/workflows${q ? `?q=${enc(q)}` : ''}`),
    createWorkflow: (body) => request('POST', '/api/workflows', body || {}),
    getWorkflow: (id) => request('GET', `/api/workflows/${enc(id)}`),
    saveWorkflow: (id, body, options) => request('PUT', `/api/workflows/${enc(id)}`, body, options),
    patchWorkflow: (id, body) => request('PATCH', `/api/workflows/${enc(id)}`, body),
    deleteWorkflow: (id) => request('DELETE', `/api/workflows/${enc(id)}`),
    duplicateWorkflow: (id) => request('POST', `/api/workflows/${enc(id)}/duplicate`, {}),
    exportUrl: (id) => rel(`/api/workflows/${enc(id)}/export`),
    exportWorkflow: (id) => request('GET', `/api/workflows/${enc(id)}/export`),
    exportZipUrl: (id) => rel(`/api/workflows/${enc(id)}/export.zip`),
    exportInfo: (id) => request('GET', `/api/workflows/${enc(id)}/export-info`),
    importWorkflow: (document) => request('POST', '/api/workflows/import', { document }),
    importAsset: (id, sessionId, assetId) => request('POST', `/api/workflows/${enc(id)}/import-asset`, { sessionId, assetId }),
    assets: (id) => request('GET', `/api/workflows/${enc(id)}/assets`),
    // run UX (WP6)
    plan: (id, body) => request('POST', `/api/workflows/${enc(id)}/runs/plan`, body || {}),
    startRun: (id, body) => request('POST', `/api/workflows/${enc(id)}/runs`, body || {}),
    getRun: (id, runId) => request('GET', `/api/workflows/${enc(id)}/runs/${enc(runId)}`),
    listRuns: (id, limit) => request('GET', `/api/workflows/${enc(id)}/runs${limit ? `?limit=${enc(limit)}` : ''}`),
    cancelRun: (id, runId) => request('POST', `/api/workflows/${enc(id)}/runs/${enc(runId)}/cancel`, {}),
    selectVariant: (id, nodeId, entry, variant) => request('PATCH', `/api/workflows/${enc(id)}/results/${enc(nodeId)}`, { entry, variant }),
    outputsZipUrl: (id, runId) => rel(`/api/workflows/${enc(id)}/outputs.zip${runId ? `?runId=${enc(runId)}` : ''}`)
  };
})(window);
