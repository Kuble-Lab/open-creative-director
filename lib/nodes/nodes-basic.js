'use strict';

// Basic node types (SPEC §5.1 inputs, §5.2 text and utility). All pure or ledger-backed; no provider costs.

const assets = require('./assets');
const { textValue, numberValue, listValue, isListValue } = require('./types');

const MEDIA_KINDS = ['image', 'video', 'audio'];
const MAX_MEDIA_LIST = 50;

// Separators typed into single-line fields: allow the escapes \n, \r\n and \t.
function unescapeSeparator(value) {
  return String(value).replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

// One item per line, or blocks separated by a line consisting of `---`.
function parseTextList(text, max) {
  const lines = String(text || '').split(/\r?\n/);
  let items;
  if (lines.some((line) => line.trim() === '---')) {
    items = [];
    let block = [];
    for (const line of lines) {
      if (line.trim() === '---') {
        items.push(block.join('\n'));
        block = [];
      } else {
        block.push(line);
      }
    }
    items.push(block.join('\n'));
  } else {
    items = lines;
  }
  items = items.map((item) => item.trim()).filter(Boolean);
  return Number.isFinite(max) && max > 0 ? items.slice(0, max) : items;
}

function hasAssetRef(param) {
  return Boolean(assets.assetRefFromParam(param, 'placeholder'));
}

// Codes asset_lost / no_asset have a translated text in the node view (nodes.issue.<code>).
function assetParamIssue(param, label) {
  if (param && typeof param === 'object' && param.missing === true) return { code: 'asset_lost', message: `${label}: asset is missing, upload it again` };
  if (!hasAssetRef(param)) return { code: 'no_asset', message: `${label}: no asset selected` };
  return null;
}

function mediaInputDefinition(kind) {
  return {
    type: `input.${kind}`,
    category: 'input',
    label: `${kind[0].toUpperCase()}${kind.slice(1)} input`,
    keywords: [kind, 'upload', 'file', 'media'],
    inputs: [],
    outputs: [{ id: kind, type: kind }],
    params: [{ id: 'asset', kind: 'asset', accept: kind, inline: true, default: null }],
    validate: (params) => {
      const issue = assetParamIssue(params.asset, kind);
      return issue ? [issue] : [];
    },
    execute: async (ctx, _inputs, params) => {
      const value = await assets.resolveAssetParam(params.asset, ctx.sessionId, kind);
      return { variants: [{ [kind]: value }] };
    }
  };
}

const definitions = [
  {
    // Dedicated prompt node: the same value as input.text, but named and laid out for writing prompts
    // on the canvas (large inline field). input.text stays registered so saved workflows keep working.
    type: 'input.prompt',
    category: 'input',
    label: 'Prompt',
    keywords: ['prompt', 'text', 'idea', 'description'],
    outputs: [{ id: 'prompt', type: 'text' }],
    params: [{ id: 'prompt', kind: 'textarea', default: '', inline: true }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ prompt: textValue(params.prompt) }] })
  },
  {
    type: 'input.text',
    category: 'input',
    label: 'Text input',
    keywords: ['text', 'prompt', 'string'],
    outputs: [{ id: 'text', type: 'text' }],
    params: [{ id: 'text', kind: 'textarea', default: '', inline: true }],
    execute: async (_ctx, _inputs, params) => ({ variants: [{ text: textValue(params.text) }] })
  },
  {
    type: 'input.number',
    category: 'input',
    label: 'Number input',
    keywords: ['number', 'value', 'integer', 'float'],
    outputs: [{ id: 'value', type: 'number' }],
    params: [
      { id: 'value', kind: 'number', default: 0, inline: true },
      { id: 'min', kind: 'number', optional: true, default: null },
      { id: 'max', kind: 'number', optional: true, default: null },
      { id: 'step', kind: 'number', optional: true, default: null }
    ],
    validate: (params) => {
      const issues = [];
      if (params.min !== null && params.max !== null && params.min > params.max) issues.push('min is greater than max');
      if (params.min !== null && params.value < params.min) issues.push(`value is below min (${params.min})`);
      if (params.max !== null && params.value > params.max) issues.push(`value is above max (${params.max})`);
      return issues;
    },
    execute: async (_ctx, _inputs, params) => ({ variants: [{ value: numberValue(params.value) }] })
  },
  {
    type: 'input.text_list',
    category: 'input',
    label: 'Text list',
    keywords: ['list', 'batch', 'lines', 'prompts'],
    outputs: [{ id: 'items', type: 'text[]' }],
    params: [
      { id: 'text', kind: 'textarea', default: '', inline: true },
      { id: 'max', kind: 'integer', default: 50, min: 1, max: 500 }
    ],
    validate: (params) => (parseTextList(params.text).length ? [] : [{ level: 'warning', message: 'the list is empty' }]),
    execute: async (ctx, _inputs, params) => {
      const all = parseTextList(params.text);
      const items = all.slice(0, params.max);
      if (items.length < all.length) ctx.log(`List truncated to ${items.length} of ${all.length} items`);
      return { variants: [{ items: listValue('text', items.map(textValue)) }] };
    }
  },
  mediaInputDefinition('image'),
  mediaInputDefinition('video'),
  mediaInputDefinition('audio'),
  {
    type: 'input.media_list',
    category: 'input',
    label: 'Media list',
    keywords: ['list', 'batch', 'images', 'videos', 'audios', 'files'],
    outputs: [{ id: 'items', type: 'image[]' }],
    params: [
      { id: 'kind', kind: 'select', options: MEDIA_KINDS, default: 'image' },
      { id: 'assets', kind: 'assets', accept: 'kind', max: MAX_MEDIA_LIST, inline: true, default: [] }
    ],
    portVariants: {
      param: 'kind',
      values: {
        image: { outputs: [{ id: 'items', type: 'image[]' }] },
        video: { outputs: [{ id: 'items', type: 'video[]' }] },
        audio: { outputs: [{ id: 'items', type: 'audio[]' }] }
      }
    },
    validate: (params) => {
      const issues = [];
      const list = Array.isArray(params.assets) ? params.assets : [];
      if (!list.length) issues.push({ level: 'warning', message: 'the list is empty' });
      if (list.length > MAX_MEDIA_LIST) issues.push(`at most ${MAX_MEDIA_LIST} assets are allowed`);
      list.forEach((entry, index) => {
        const issue = assetParamIssue(entry, `asset ${index + 1}`);
        if (issue) issues.push(issue);
      });
      return issues;
    },
    execute: async (ctx, _inputs, params) => {
      const kind = MEDIA_KINDS.includes(params.kind) ? params.kind : 'image';
      const list = Array.isArray(params.assets) ? params.assets.slice(0, MAX_MEDIA_LIST) : [];
      const items = [];
      for (let index = 0; index < list.length; index += 1) {
        try {
          items.push(await assets.resolveAssetParam(list[index], ctx.sessionId, kind));
        } catch (err) {
          throw new Error(`Asset ${index + 1}: ${err.message}`);
        }
      }
      return { variants: [{ items: listValue(kind, items) }] };
    }
  },
  {
    type: 'text.template',
    category: 'text',
    label: 'Text template',
    keywords: ['template', 'concat', 'concatenate', 'prompt', 'placeholder'],
    inputs: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, type: 'text' })),
    outputs: [{ id: 'text', type: 'text' }],
    params: [{ id: 'template', kind: 'textarea', default: '{{a}} {{b}}', inline: true }],
    // {{a}}..{{e}} are replaced (empty when the port is unconnected); other placeholders stay literal.
    execute: async (_ctx, inputs, params) => {
      const text = String(params.template).replace(/\{\{\s*([a-e])\s*\}\}/g, (_match, id) => inputs[id]?.value ?? '');
      return { variants: [{ text: textValue(text) }] };
    }
  },
  {
    type: 'text.join',
    category: 'text',
    label: 'Join text',
    keywords: ['join', 'concat', 'merge', 'combine'],
    inputs: [{ id: 'items', type: 'text', multiple: true, required: true }],
    outputs: [{ id: 'text', type: 'text' }],
    params: [{ id: 'separator', kind: 'text', default: '\n' }],
    execute: async (_ctx, inputs, params) => {
      const items = (inputs.items?.items || []).map((item) => item.value);
      return { variants: [{ text: textValue(items.join(unescapeSeparator(params.separator))) }] };
    }
  },
  {
    type: 'text.split',
    category: 'text',
    label: 'Split text',
    keywords: ['split', 'lines', 'list', 'batch'],
    inputs: [{ id: 'text', type: 'text', required: true }],
    outputs: [{ id: 'items', type: 'text[]' }],
    params: [
      { id: 'separator', kind: 'text', default: '\n' },
      { id: 'trim', kind: 'boolean', default: true },
      { id: 'max', kind: 'integer', default: 50, min: 1, max: 500 }
    ],
    // Empty entries are dropped; an empty separator splits on newlines.
    execute: async (_ctx, inputs, params) => {
      const separator = unescapeSeparator(params.separator) || '\n';
      let parts = String(inputs.text.value).split(separator === '\n' ? /\r?\n/ : separator);
      if (params.trim) parts = parts.map((part) => part.trim());
      parts = parts.filter((part) => part.trim() !== '').slice(0, params.max);
      return { variants: [{ items: listValue('text', parts.map(textValue)) }] };
    }
  },
  {
    type: 'util.pick',
    category: 'utility',
    label: 'Pick item',
    keywords: ['pick', 'select', 'index', 'list', 'item'],
    inputs: [{ id: 'items', type: 'any[]', required: true }],
    outputs: [{ id: 'item', type: 'any' }],
    params: [{ id: 'index', kind: 'integer', default: 0, inline: true }],
    // Negative indexes count from the end.
    execute: async (_ctx, inputs, params) => {
      const items = inputs.items.items;
      const index = params.index < 0 ? items.length + params.index : params.index;
      if (index < 0 || index >= items.length) {
        throw new Error(`Index ${params.index} is out of range (list has ${items.length} items)`);
      }
      return { variants: [{ item: items[index] }] };
    }
  },
  {
    type: 'util.router',
    category: 'utility',
    label: 'Router',
    keywords: ['router', 'switch', 'select', 'choose'],
    inputs: [{ id: 'inputs', type: 'any', multiple: true, required: true }],
    outputs: [{ id: 'out', type: 'any' }],
    params: [{ id: 'index', kind: 'integer', default: 0, inline: true }],
    execute: async (_ctx, inputs, params) => {
      const items = inputs.inputs?.items || [];
      if (params.index < 0 || params.index >= items.length) {
        throw new Error(`Index ${params.index} is out of range (${items.length} inputs connected)`);
      }
      return { variants: [{ out: items[params.index] }] };
    }
  },
  {
    type: 'output.result',
    category: 'output',
    label: 'Result',
    keywords: ['output', 'result', 'export', 'download', 'app'],
    inputs: [{ id: 'inputs', type: 'any', multiple: true }],
    // Hidden passthrough that stores what the node received, so the result list, ZIP download,
    // send-to-chat and Design App outputs can read it from results.json. Not connectable.
    outputs: [{ id: 'result', type: 'any', hidden: true }],
    params: [{ id: 'label', kind: 'text', default: '', inline: true }],
    execute: async (_ctx, inputs) => {
      const received = inputs.inputs && isListValue(inputs.inputs) ? inputs.inputs : listValue('any', []);
      return { variants: [{ result: received }] };
    }
  }
];

function registerAll(registry) {
  for (const definition of definitions) registry.register(definition);
}

module.exports = { definitions, registerAll, parseTextList, unescapeSeparator };
