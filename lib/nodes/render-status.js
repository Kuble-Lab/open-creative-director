'use strict';

// Only display names enter the node status, never worker addresses, leases or job payloads.
function renderStatus(jobs) {
  const entries = [...jobs.values()];
  const running = entries.filter((job) => job.status === 'running');
  const completed = entries.length && entries.every((job) => job.status === 'completed');
  const shown = running.length ? running : completed ? entries : [];
  const names = [...new Set(shown.map((job) => typeof job.nodeName === 'string' ? job.nodeName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '').filter(Boolean))];
  return names.length ? { phase: running.length ? 'rendering' : 'completed', names } : null;
}

// A workflow may be shared with participants. Filter for the viewer, not the person who started the run.
function publicStatus(value, viewer) {
  if (viewer && (viewer.active === false || viewer.admin || viewer.kind === 'internal')) return value;
  const neutral = (entry) => entry ? { phase: entry.phase, count: Array.isArray(entry.names) ? entry.names.length : entry.count || 1 } : null;
  return JSON.parse(JSON.stringify(value, (key, entry) => {
    if (key === 'render') return neutral(entry);
    if (key === 'nodeRenders' && entry) return Object.fromEntries(Object.entries(entry).map(([id, render]) => [id, neutral(render)]));
    return entry;
  }));
}

module.exports = { renderStatus, publicStatus };
