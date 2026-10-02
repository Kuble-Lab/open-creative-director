#!/usr/bin/env node
'use strict';

/*
 * Runs every scripts/test-*.js as its own Node process.
 *
 * A test only counts as passed when
 *   1. it exits with code 0 AND
 *   2. its last non-empty stdout line is "<file name>: ok".
 *
 * The second rule catches a silent end: a promise that never settles empties the
 * event loop and Node exits with 0 although the rest of the test never ran.
 *
 * Usage:
 *   node scripts/run-tests.js [filter ...] [--timeout=<seconds>] [--jobs=<n>]
 *   npm test -- nodes-generate --timeout=600
 *
 * A filter is a part of a file name ("nodes-" runs every node-view test).
 * Defaults: one test after another, 240 s per test. --jobs=<n> runs several at once; tests
 * that use the shared local data folders can then get in each other's way.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS_DIR = __dirname;
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const DEFAULT_TIMEOUT_SECONDS = 240;
// Tests share the local data folders (data/, projects/), so by default they run one after another.
const DEFAULT_JOBS = 1;
const OUTPUT_TAIL_LINES = 25;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const options = { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, jobs: DEFAULT_JOBS, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let match;
    if ((match = /^--timeout(?:=(.*))?$/.exec(arg))) {
      const value = match[1] !== undefined ? match[1] : argv[++i];
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--timeout needs a number of seconds above 0, got "${value}"`);
      options.timeoutSeconds = seconds;
    } else if ((match = /^--jobs(?:=(.*))?$/.exec(arg))) {
      const value = match[1] !== undefined ? match[1] : argv[++i];
      const jobs = Number(value);
      if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs needs a whole number above 0, got "${value}"`);
      options.jobs = jobs;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.filters.push(arg);
    }
  }
  return options;
}

function listTests(filters) {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => /^test-.*\.js$/.test(name))
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();
}

function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i].trim();
  }
  return '';
}

function tail(text, count) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-count).join('\n');
}

function runTest(name, timeoutSeconds) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;
    let killTimer = null;

    const child = spawn(process.execPath, [path.join('scripts', name)], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeoutSeconds * 1000);

    const done = (code, signal, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const seconds = (Date.now() - started) / 1000;
      const expected = `${name}: ok`;
      let ok = false;
      let reason = '';
      if (spawnError) {
        reason = `could not start: ${spawnError.message}`;
      } else if (timedOut) {
        reason = `timeout after ${timeoutSeconds} s`;
      } else if (code !== 0) {
        reason = signal ? `ended by signal ${signal}` : `exit code ${code}`;
      } else if (lastNonEmptyLine(stdout) !== expected) {
        reason = `silent end: exit 0, but the last stdout line is not "${expected}"`;
      } else {
        ok = true;
      }
      resolve({ name, ok, reason, seconds, stdout, stderr });
    };

    child.on('error', (error) => done(null, null, error));
    child.on('close', (code, signal) => done(code, signal, null));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/run-tests.js [filter ...] [--timeout=<seconds>] [--jobs=<n>]');
    return 0;
  }
  const tests = listTests(options.filters);
  if (tests.length === 0) {
    console.error(`No test matches ${options.filters.length ? options.filters.map((f) => `"${f}"`).join(', ') : 'scripts/test-*.js'}.`);
    return 1;
  }

  const startedAll = Date.now();
  console.log(`Running ${tests.length} test${tests.length === 1 ? '' : 's'}, ${Math.min(options.jobs, tests.length)} in parallel, timeout ${options.timeoutSeconds} s each.`);

  const results = [];
  let next = 0;
  async function worker() {
    while (next < tests.length) {
      const name = tests[next++];
      const result = await runTest(name, options.timeoutSeconds);
      results.push(result);
      const duration = `${result.seconds.toFixed(1)} s`;
      if (result.ok) {
        console.log(`PASS ${result.name} (${duration})`);
      } else {
        console.log(`FAIL ${result.name} (${duration}): ${result.reason}`);
        const output = [tail(result.stdout, OUTPUT_TAIL_LINES), tail(result.stderr, OUTPUT_TAIL_LINES)].filter(Boolean);
        if (output.length) console.log(output.join('\n').split('\n').map((line) => `    ${line}`).join('\n'));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.jobs, tests.length) }, worker));

  const failed = results.filter((result) => !result.ok).sort((a, b) => a.name.localeCompare(b.name));
  const passed = results.length - failed.length;
  const totalSeconds = ((Date.now() - startedAll) / 1000).toFixed(1);
  console.log('');
  if (failed.length) {
    console.log('Failed:');
    for (const result of failed) console.log(`  ${result.name}: ${result.reason}`);
  }
  console.log(`${passed}/${results.length} passed (${totalSeconds} s)`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
);
