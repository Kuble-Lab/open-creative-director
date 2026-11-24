'use strict';

// Review geometry and playback decisions, shared by the browser and plain Node tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.OCDNodes = root.OCDNodes || {};
    root.OCDNodes.timeline = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function beingMade(clip, run) {
    if (!clip.producer || !run?.active) return false;
    const { nodeId, item } = clip.producer;
    const request = run.request || run;
    if (request.mode === 'items') {
      const target = request.nodeId || request.itemsRun?.nodeId || (request.targets?.length === 1 ? request.targets[0] : null);
      if (target !== nodeId || !(request.items || request.itemsRun?.items)?.includes(item)) return false;
    } else if (!(run.targets || []).includes(nodeId) && !run.nodes?.[nodeId]) return false;
    const status = run.nodes?.[nodeId]?.status;
    return !status || ['queued', 'running', 'waiting_job', 'awaiting_approval'].includes(status);
  }

  function status(clip, run) {
    if (beingMade(clip, run)) return 'remaking';
    if (clip.missing || !clip.asset) return 'missing';
    if (clip.review?.status === 'approved' && clip.review.assetId === clip.asset.id) return 'approved';
    if (clip.review?.feedback?.length) return 'feedback';
    return 'open';
  }

  function counts(clips, run) {
    const result = { total: clips.length, approved: 0, feedback: 0, remaking: 0, open: 0, missing: 0, remaining: 0 };
    for (const clip of clips) result[status(clip, run)]++;
    result.remaining = result.total - result.approved;
    return result;
  }

  function filter(clips, value = 'all', run) {
    return clips.filter((clip) => value === 'open' ? status(clip, run) !== 'approved' : value === 'lipsync' ? clip.lipsync : true);
  }

  function layout(model, { zoom = 30, start = 0, width = Infinity, filter: value = 'all', run } = {}) {
    const scale = clamp(finite(zoom, 30), 2, 240);
    const duration = Math.max(0, finite(model.duration));
    const from = clamp(finite(start), 0, duration);
    const end = Math.min(duration, from + Math.max(0, width) / scale);
    return { scale, start: from, end, width: duration * scale,
      clips: filter(model.clips || [], value, run)
        .filter((clip) => clip.start + clip.duration > from && clip.start < end)
        .map((clip) => ({ clip, left: clip.start * scale, width: Math.max(0, clip.duration * scale),
          overWidth: Math.max(0, finite(clip.over) * scale), status: status(clip, run) })) };
  }

  // Overlapping crossfades belong to the later clip; a gap has no clip.
  function clipAt(clips, time) {
    if (!Number.isFinite(time) || time < 0) return null;
    let found = null;
    for (const clip of clips) if (time >= clip.start && time < clip.start + clip.duration && (!found || clip.start >= found.start)) found = clip;
    return found;
  }

  function range(clips, key, mode = 'clip') {
    const index = clips.findIndex((clip) => clip.key === key);
    if (index < 0) return null;
    const first = mode === 'neighbours' ? Math.max(0, index - 1) : index;
    const last = mode === 'from' ? clips.length - 1 : mode === 'neighbours' ? Math.min(clips.length - 1, index + 1) : index;
    return { start: clips[first].start, end: clips[last].start + clips[last].duration };
  }

  // Max absolute sample per bucket, over every channel. Silence and empty buckets remain zero.
  function peaks(channels, buckets = 512) {
    const count = clamp(Math.floor(finite(buckets, 512)), 1, 8192);
    const lists = ArrayBuffer.isView(channels) ? [channels] : Array.isArray(channels) && typeof channels[0] === 'number' ? [channels] : channels || [];
    const length = Math.max(0, ...lists.map((samples) => samples.length));
    const result = Array(count).fill(0);
    for (let index = 0; index < length; index++) {
      const bucket = Math.min(count - 1, Math.floor(index * count / length));
      for (const samples of lists) result[bucket] = Math.max(result[bucket], clamp(Math.abs(finite(samples[index])), 0, 1));
    }
    return result;
  }

  function keyAction(event) {
    const target = event.target;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat ||
      target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|VIDEO|AUDIO)$/.test(target?.tagName || '')) return null;
    return ({ ' ': 'play', ArrowLeft: 'previous', ArrowRight: 'next', o: 'approve', O: 'approve' })[event.key] || null;
  }

  function clock(seconds) {
    const tenths = Math.round(Math.max(0, finite(seconds)) * 10);
    return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
  }

  return { beingMade, status, counts, filter, layout, clipAt, range, peaks, keyAction, clock };
});
