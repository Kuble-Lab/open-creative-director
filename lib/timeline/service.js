'use strict';

const fsp = require('fs/promises');
const assets = require('../nodes/assets');
const sessions = require('../store');
const { reviewForAsset } = require('./review-store');

const atItem = (value, item) => value?.type === 'list' ? value.items[item] : item === null || item === 0 ? value : undefined;
const media = (value) => value && ['video', 'audio', 'image'].includes(value.type) && typeof value.assetId === 'string' && value.missing !== true;
const sameAsset = (a, b) => media(a) && media(b) && a.assetId === b.assetId && a.sessionId === b.sessionId;
const assetView = (value) => media(value) ? { id: value.assetId, url: value.url, duration: Number.isFinite(value.duration) ? value.duration : null } : null;

async function storedAsset(value) {
  if (!media(value)) return null;
  const ledger = await sessions.readLedger(value.sessionId);
  const entry = ledger.find((item) => item.id === value.assetId);
  if (!entry) return null;
  const resolved = assets.valueFromLedgerEntry(value.sessionId, entry);
  await fsp.access(assets.assetFilePath(resolved));
  if (resolved.type !== 'image' && !resolved.duration) resolved.duration = await assets.probeUploadSeconds(assets.assetFilePath(resolved));
  return resolved;
}

function createTimelineService({ store, registry, engine = require('../nodes/engine'), reviewStore = store?.timelineReviews, resolveAsset = storedAsset } = {}) {
  if (!store || !registry) throw new Error('Timeline service needs a store and registry');

  function context(workflow, results, node) {
    const def = registry.get(node.type);
    if (!def) return null;
    const params = engine.effectiveParams(registry, def, node);
    const ports = registry.portsFor(def, params);
    return { def, params, ports, ...engine.resolveStoredInputs({ node, ports, params, edges: workflow.graph.edges, results }) };
  }

  // Resolve the edge position before following any pass-through. Repeated assets are still distinct items.
  function producerOf(workflow, results, target, port, item, value) {
    const nodes = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
    const seen = new Set();
    const output = (id, portId) => engine.selectedVariant(results.nodes?.[id])?.[portId];
    function throughInput(node, portId, index) {
      const ctx = context(workflow, results, node);
      const input = ctx?.ports.inputs.find((entry) => entry.id === portId);
      if (!input || ctx.errors[portId]) return null;
      const edges = workflow.graph.edges.filter((edge) => edge.to.node === node.id && edge.to.port === portId);
      let offset = 0;
      for (const edge of input.multiple ? edges : edges.slice(0, 1)) {
        const source = output(edge.from.node, edge.from.port);
        if (!source) return null;
        const length = source.type === 'list' ? source.items.length : 1;
        const position = index === null ? 0 : index;
        if (position >= offset && position < offset + length) return trace(edge.from.node, edge.from.port, source.type === 'list' ? position - offset : null);
        offset += length;
      }
      return null;
    }
    function trace(nodeId, portId, index) {
      const key = JSON.stringify([nodeId, portId, index]);
      if (seen.has(key)) return null;
      seen.add(key);
      const node = nodes.get(nodeId), ctx = node && context(workflow, results, node);
      if (!ctx || !sameAsset(atItem(output(nodeId, portId), index), value)) return null;
      if (node.type === 'util.pick') {
        const list = ctx.inputs.items?.items;
        if (!list) return null;
        const picked = ctx.params.index < 0 ? list.length + ctx.params.index : ctx.params.index;
        return sameAsset(list[picked], value) ? throughInput(node, 'items', picked) : null;
      }
      if (node.type === 'util.router') return throughInput(node, 'inputs', ctx.params.index);
      if (node.type === 'input.media_list') {
        // Upload lists can reference generated assets. Only a unique stored producer can be followed.
        const candidates = [];
        for (const other of workflow.graph.nodes) {
          const def = registry.get(other.type);
          if (!def || def.category === 'input' || def.category === 'utility') continue;
          for (const [outPort, outValue] of Object.entries(engine.selectedVariant(results.nodes?.[other.id]) || {})) {
            const values = outValue?.type === 'list' ? outValue.items : [outValue];
            values.forEach((candidate, at) => {
              if (sameAsset(candidate, value)) candidates.push({ node: other, port: outPort, item: outValue?.type === 'list' ? at : null });
            });
          }
        }
        return candidates.length === 1 ? trace(candidates[0].node.id, candidates[0].port, candidates[0].item) : null;
      }
      if (['input', 'utility', 'output'].includes(ctx.def.category)) return null;
      return { nodeId, item: index };
    }
    return throughInput(target, port, item);
  }

  function promptOf(ctx, item) {
    if (!Number.isSafeInteger(item) || item < 0) return null;
    for (const port of ctx.ports.inputs) {
      if (port.type !== 'text' || port.multiple || !ctx.mapped.includes(port.id)) continue;
      const value = ctx.inputs[port.id]?.items?.[item];
      if (value?.type === 'text' && typeof value.value === 'string') return { port: port.id, text: value.value };
    }
    return null;
  }

  async function buildView(workflow, results, node, reviews, hydrate) {
    const ctx = context(workflow, results, node);
    if (typeof ctx?.def.timeline !== 'function') return null;
    const inputs = {};
    for (const [port, value] of Object.entries(ctx.inputs)) inputs[port] = await hydrate(value);
    const model = ctx.def.timeline({ inputs, params: ctx.params });
    if (!model) return null;
    const clips = model.clips.map((clip) => {
      const value = atItem(inputs[clip.port], clip.item);
      const asset = assetView(value);
      const producer = asset ? producerOf(workflow, results, node, clip.port, clip.item, value) : null;
      const source = producer && workflow.graph.nodes.find((entry) => entry.id === producer.nodeId);
      const sourceContext = source && context(workflow, results, source);
      const prompt = sourceContext && promptOf(sourceContext, producer.item);
      const notes = sourceContext && Number.isSafeInteger(producer.item) && sourceContext.def.params.some((param) =>
        param.kind === 'notes' && param.items && sourceContext.inputs[param.items]?.type === 'list' && producer.item < sourceContext.inputs[param.items].items.length);
      const over = clip.lipsync && asset?.duration - clip.duration > 0.3 + 1e-9 ? asset.duration - clip.duration : 0;
      return { ...clip, asset, over, missing: !asset, producer, prompt: prompt?.text ?? null, promptPort: prompt?.port ?? null,
        feedbackCapability: notes ? 'notes' : prompt ? 'prompt' : null,
        ...(clip.sound ? { soundAsset: assetView(atItem(inputs[clip.sound.port], clip.sound.item)) } : {}),
        review: reviewForAsset(reviews.nodes?.[node.id]?.[clip.key], asset?.id) };
    });
    return { ...model, workflowId: workflow.id, nodeId: node.id, label: node.label || ctx.def.label,
      audioAsset: model.audio ? assetView(atItem(inputs[model.audio.port], model.audio.item)) : null, clips };
  }

  function hydrator(workflow) {
    const cache = new Map();
    return async function hydrate(value) {
      if (value?.type === 'list') return { ...value, items: await Promise.all(value.items.map(hydrate)) };
      if (!media(value)) return value;
      const key = JSON.stringify([value.sessionId, value.assetId]);
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => resolveAsset(value, { workflow })).catch(() => null));
      const resolved = await cache.get(key);
      // Keep known slot lengths and list positions even if the file has disappeared.
      return media(resolved) ? { ...value, ...resolved } : { ...value, missing: true };
    };
  }

  async function getTimeline(workflowId, nodeId) {
    const { workflow, results } = await store.getWorkflow(workflowId);
    const node = workflow.graph.nodes.find((entry) => entry.id === nodeId);
    if (!node) throw Object.assign(new Error('Timeline node not found'), { code: 'NODE_NOT_FOUND' });
    const reviews = reviewStore ? await reviewStore.read(workflowId) : { nodes: {} };
    return buildView(workflow, results, node, reviews, hydrator(workflow));
  }

  async function listTimelineNodes(workflowId) {
    const { workflow, results } = await store.getWorkflow(workflowId);
    const hydrate = hydrator(workflow), list = [];
    for (const node of workflow.graph.nodes) {
      if (typeof registry.get(node.type)?.timeline !== 'function') continue;
      const view = await buildView(workflow, results, node, { nodes: {} }, hydrate);
      if (view) list.push({ nodeId: node.id, type: node.type, label: view.label, duration: view.duration, clips: view.clips.length });
    }
    return list;
  }

  return { listTimelineNodes, getTimeline };
}

module.exports = { createTimelineService };
