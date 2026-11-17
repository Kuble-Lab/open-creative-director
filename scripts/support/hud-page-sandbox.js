'use strict';

// Run the actual inline scripts, with a deterministic GSAP clock and just the DOM operations the HUD uses.
const vm = require('vm');
module.exports = function pageSandbox(html) {
  const elements = {};
  const make = (id) => ({ id, innerHTML: '', textContent: '', hidden: false, style: {}, attributes: {}, className: '',
    setAttribute(name, value) { this.attributes[name] = value; } });
  const get = (id) => elements[id] || (elements[id] = make(id));
  get('l-words').firstElementChild = make('word');
  const ticks = [];
  const sandbox = { console, document: { getElementById: get }, gsap: { timeline: () => ({ to(target, options) { ticks.push({ target, options }); return this; } }) } };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], sandbox, { filename: 'hud-chunk.js' });
  return { sandbox, elements, draw(local) { for (const tick of ticks) { tick.target.t = local; tick.options.onUpdate(); } } };
};
