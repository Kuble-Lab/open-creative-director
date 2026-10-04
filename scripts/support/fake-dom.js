'use strict';

// Test support (not a test): a small stand-in for the DOM, just what public/nodes/node-ui.js and preview.js touch, and a loader that runs
// the node-view scripts in a vm context in a chosen language. No browser, no network. (The same stand-in is inlined in
// test-nodes-model-viewer.js; this copy lets newer tests share it without touching that file.)
//
//   const page = loadPage('de', { userAgent });      // { window, document, OCD, root }
//   page.OCD.preview.mediaNode(value)               // a FakeNode with .classes, .tagName, .children

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const graphLib = require('../../public/nodes/graph');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

class FakeNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.textValue = '';
    this.classes = new Set();
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((name) => self.classes.add(name)),
      remove: (...names) => names.forEach((name) => self.classes.delete(name)),
      contains: (name) => self.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !self.classes.has(name) : Boolean(force);
        if (on) self.classes.add(name);
        else self.classes.delete(name);
        return on;
      }
    };
  }
  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set textContent(value) {
    this.children = [];
    this.textValue = String(value);
  }
  get textContent() {
    return this.textValue + this.children.map((child) => child.textContent).join('');
  }
  get isConnected() {
    return true;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn);
  }
  focus() {}
  contains() {
    return false;
  }
  closest() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  // sends an event to the listeners of this node; returns what they did with it
  fire(type, init = {}) {
    const event = { type, target: this, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
  find(predicate, found = []) {
    if (predicate(this)) found.push(this);
    for (const child of this.children) if (child.find) child.find(predicate, found);
    return found;
  }
}

function makeDocument() {
  const defined = new Set();
  const waiting = new Map();
  const document = {
    documentElement: { lang: '' },
    head: new FakeNode('head'),
    body: new FakeNode('body'),
    activeElement: null,
    baseURI: 'http://localhost:3000/app/',
    listeners: {},
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      (document.listeners[type] = document.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      document.listeners[type] = (document.listeners[type] || []).filter((item) => item !== fn);
    }
  };
  const customElements = {
    get: (name) => (defined.has(name) ? function Defined() {} : undefined),
    whenDefined: (name) => (defined.has(name) ? Promise.resolve() : new Promise((resolve) => waiting.set(name, resolve))),
    define(name) {
      defined.add(name);
      if (waiting.has(name)) waiting.get(name)();
    }
  };
  return { document, customElements };
}

// A page with the node-view scripts the test needs, in the language `lang`.
function loadPage(lang, { scripts = ['node-ui', 'preview'], api = {}, userAgent = '' } = {}) {
  const storage = new Map([['vcd-lang', lang]]);
  const { document, customElements } = makeDocument();
  const window = {
    document,
    customElements,
    navigator: { language: lang, userAgent },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    OCDNodes: { graph: graphLib, api: { rel: (url) => String(url).replace(/^\/+/, ''), options: async () => ({ options: [] }), ...api } }
  };
  const timers = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer.unref) timer.unref();
    return timer;
  };
  const context = { window, document, setTimeout: timers, clearTimeout, URL, Blob };
  vm.runInNewContext(read('public/i18n.js'), context, { filename: 'public/i18n.js' });
  vm.runInNewContext(read('public/nodes/i18n-nodes.js'), context, { filename: 'public/nodes/i18n-nodes.js' });
  for (const name of scripts) vm.runInNewContext(read(`public/nodes/${name}.js`), context, { filename: `public/nodes/${name}.js` });
  const holder = new FakeNode('div');
  if (window.OCDNodes.ui && window.OCDNodes.ui.setRoot) window.OCDNodes.ui.setRoot(holder);
  return { window, document, customElements, OCD: window.OCDNodes, root: holder };
}


module.exports = { FakeNode, makeDocument, loadPage };
