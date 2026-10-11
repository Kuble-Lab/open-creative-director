'use strict';

const { TEXT_LIMITS, checkGraphics, checkScreenText, checkLowerThirdTexts } = require('./contract');

function textFields(graphics) {
  const fields = [];
  const add = (prefix, item, keys) => {
    if (!item) return;
    for (const [key, limit] of keys) fields.push({ path: `${prefix}.${key}`, value: item[key] || '', max: TEXT_LIMITS[limit] });
  };
  add('title', graphics.title, [['text', 'title'], ['sub', 'sub']]);
  (graphics.intertitles || []).forEach((item, i) => add(`intertitles.${i}`, item, [['text', 'intertitle']]));
  (graphics.lower_thirds || []).forEach((item, i) => add(`lower_thirds.${i}`, item, [['name', 'name'], ['role', 'role'], ['label', 'label']]));
  add('endcard', graphics.endcard, [['line', 'endcardLine'], ['sub', 'endcardSub'], ['url', 'url']]);
  return fields;
}

function validateTextOverrides(raw) {
  if (!raw) return [];
  let field = 'text_overrides';
  try {
    const patch = JSON.parse(raw);
    const basis = JSON.parse(patch.base);
    if (!Array.isArray(basis) || !patch.values || typeof patch.values !== 'object' || Array.isArray(patch.values)) throw new Error('Invalid text corrections');
    const limits = { 'title.text': TEXT_LIMITS.title, 'title.sub': TEXT_LIMITS.sub, 'endcard.line': TEXT_LIMITS.endcardLine, 'endcard.sub': TEXT_LIMITS.endcardSub, 'endcard.url': TEXT_LIMITS.url };
    const fields = new Map();
    for (const item of basis) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string' || fields.has(item[0])) throw new Error('Invalid text basis');
      fields.set(item[0], item[1]);
    }
    for (const [key, value] of Object.entries(patch.values)) {
      field = key;
      if (!fields.has(key) || typeof value !== 'string') throw new Error('Invalid text correction');
      fields.set(key, value);
    }
    const groups = new Map();
    for (const [key, value] of fields) {
      field = key;
      const third = /^lower_thirds\.(\d+)\.(name|role|label)$/.exec(key);
      const max = Object.hasOwn(limits, key) ? limits[key] : /^intertitles\.\d+\.text$/.test(key) ? TEXT_LIMITS.intertitle : third ? TEXT_LIMITS[third[2]] : 0;
      if (!max) throw new Error('Invalid text field');
      if (Array.from(value).length > max) throw new Error('Text correction is too long');
      const normalized = value.trim() ? value : null;
      const checked = checkScreenText(normalized, { max, nullable: !/\.(text|line)$/.test(key) });
      if (!checked.ok) throw new Error(checked.problems.join('; '));
      if (third) {
        const group = `lower_thirds.${third[1]}`;
        if (!groups.has(group)) groups.set(group, {});
        groups.get(group)[third[2]] = normalized;
      }
    }
    for (const [key, third] of groups) {
      field = key;
      const checked = checkLowerThirdTexts(third);
      if (!checked.ok) throw new Error(checked.problems.join('; '));
    }
    return [];
  } catch (error) {
    return [{ level: 'error', code: 'EVENTRENDER_TEXT_INVALID', message: error.message, data: { field, problems: error.message } }];
  }
}

// The basis contains only editable text: changing photo motion can move timings without losing corrections.
function applyTextOverrides(graphics, raw) {
  if (!raw) return graphics;
  const patch = JSON.parse(raw);
  const fields = textFields(graphics);
  if (!patch || patch.base !== JSON.stringify(fields.map(({ path, value }) => [path, value]))) return graphics;
  const issues = validateTextOverrides(raw);
  if (issues.length) throw Object.assign(new Error(issues[0].message), { data: issues[0].data });
  const result = JSON.parse(JSON.stringify(graphics));
  for (const [key, value] of Object.entries(patch.values)) {
    const field = fields.find((item) => item.path === key);
    if (!field || typeof value !== 'string' || Array.from(value).length > field.max) throw new Error('Invalid text correction');
    const parts = key.split('.');
    const last = parts.pop();
    parts.reduce((item, part) => item[part], result)[last] = value.trim() ? value : null;
  }
  const check = checkGraphics(result);
  if (!check.ok) throw new Error(check.problems.slice(0, 3).join('; '));
  return result;
}

module.exports = { textFields, applyTextOverrides, validateTextOverrides };
