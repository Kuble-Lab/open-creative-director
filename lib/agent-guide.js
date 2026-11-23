'use strict';

// Shared, MCP-independent guide. Each docs/agent-guide/<id>.md starts with "# Title",
// followed immediately by a one-line summary, a blank line, then the guide text.
// No README belongs in that directory: every Markdown file is a topic. Read at runtime
// so edits are visible without rebuilding. Only directory-listed, validated IDs are used.
const fs = require('node:fs');
const path = require('node:path');
const DIRECTORY = path.join(__dirname, '..', 'docs', 'agent-guide');
const ORDER = ['workflow-basics', 'hud-music-video', 'guest-character', 'costs', 'influencers'];
const validId = (id) => typeof id === 'string' && /^[a-z0-9-]{1,80}$/.test(id);

function topicIds() {
  return fs.readdirSync(DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && validId(entry.name.slice(0, -3)))
    .map((entry) => entry.name.slice(0, -3))
    .sort((a, b) => {
      const rank = (id) => ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length;
      return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
    });
}
function load(id) {
  const text = fs.readFileSync(path.join(DIRECTORY, `${id}.md`), 'utf8');
  const [heading, summary] = text.split(/\r?\n/);
  if (!/^# .+/.test(heading) || !summary?.trim()) throw new Error(`Invalid guide format: ${id}`);
  return { id, title: heading.slice(2).trim(), summary: summary.trim(), text };
}
function listTopics() {
  return topicIds().map((id) => { const { title, summary } = load(id); return { id, title, summary }; });
}
function readTopic(id) {
  return validId(id) && topicIds().includes(id) ? load(id) : null;
}
module.exports = { listTopics, readTopic };
