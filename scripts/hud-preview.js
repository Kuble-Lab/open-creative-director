#!/usr/bin/env node
'use strict';

// Developer tool (not a test): builds a local HyperFrames project for a part of the music video HUD (lib/music-video-hud/) from a graphics file and a
// video, and renders it when HYPERFRAMES_CLI names the cli of HyperFrames. For looking at the HUD on footage without a render node, free of charge.
//
//   node scripts/hud-preview.js <graphics.json | demo> <footage.mp4> [--out <dir>] [--from <s>] [--to <s>] [--duration <s>] [--quality draft|standard|high]
//                               [--theme hud|kuble] [--accent <#rrggbb>] [--karaoke on|off] [--effects off|subtle|strong]
//
//   graphics.json   the "graphics" text of music_video.hud_plan; "demo" takes the example of lib/music-video-hud/graphics.js (--duration its length)
//   footage.mp4     the video of the whole film (the base cut of the song) that the HUD is drawn on; any video works for a look (it is cut to 24 fps, 1920x1080)
//   --from/--to     the part of the song to build (default: the first chunk); a chunk begins and ends at a cut
//   --out           the folder for the projects and the results (default ./hud-preview)
//   --theme         the style, as the parameter of the node: hud (HUD Blue, the default) or kuble (it wins over the field `theme` of the plan)
//   --accent        the accent colour, as the parameter of the node (default #3B82F6; Kuble takes its own blue for that default)
//   --karaoke       the karaoke line with the sung words, as the parameter of the node (default off: the node draws no burnt-in lyrics unless asked to)
//   --effects       the beat effects drawn in the page (zoom, shake, distortion, light, colour; WP45), as the parameter of the node (default strong); the
//                   glitch over the whole picture is made by the post-pass of the node, not here
//
// With the environment variable HYPERFRAMES_CLI (the path of hyperframes/dist/cli.js of an installed hyperframes) every chunk is rendered to
// <out>/chunk-<n>/out.mp4 with the settings of the render node (24 fps, no update check, no telemetry, screenshot capture). Without it only the
// projects are written. 2 s of the film render in about 5 s on a laptop.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const graphicsLib = require('../lib/music-video-hud/graphics');
const chunksLib = require('../lib/music-video-hud/chunks');
const composition = require('../lib/music-video-hud/composition');

const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { quality: 'draft', out: path.resolve('hud-preview'), from: null, to: null, duration: 128.4, theme: undefined, accent: undefined, karaoke: false, effects: 'strong', positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--from') options.from = Number(next());
    else if (arg === '--to') options.to = Number(next());
    else if (arg === '--duration') options.duration = Number(next());
    else if (arg === '--quality') options.quality = next();
    else if (arg === '--theme') options.theme = next();
    else if (arg === '--accent') options.accent = next();
    else if (arg === '--karaoke') {
      const value = next();
      if (value !== 'on' && value !== 'off') throw new Error('--karaoke takes on or off');
      options.karaoke = value === 'on';
    }
    else if (arg === '--effects') {
      options.effects = next();
      if (!['off', 'subtle', 'strong'].includes(options.effects)) throw new Error('--effects takes off, subtle or strong');
    }
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || '').split('\n').filter(Boolean).slice(-6).join(' | ')}`);
  return result;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [source, footage] = options.positional;
  if (!source || !footage) {
    console.error('Usage: node scripts/hud-preview.js <graphics.json | demo> <footage.mp4> [--out dir] [--from s] [--to s] [--duration s] [--quality draft|standard|high] [--theme hud|kuble] [--accent #rrggbb] [--karaoke on|off] [--effects off|subtle|strong]');
    process.exit(2);
  }
  const input = source === 'demo' ? graphicsLib.demoGraphics({ duration: options.duration }) : fs.readFileSync(source, 'utf8');
  // the parameters of the node: its accent has the default of the node, which Kuble reads as "no colour chosen"
  const { graphics, warnings } = graphicsLib.prepareGraphics(input, { theme: options.theme, accent: options.accent === undefined ? graphicsLib.DEFAULT_ACCENT : options.accent, karaoke: options.karaoke });
  for (const warning of warnings) console.log(`warning: ${warning}`);
  const chunks = chunksLib.planChunks(graphics, { endcardSeconds: graphics.endcard ? graphics.endcard.seconds : 0 });
  const from = options.from === null ? 0 : options.from;
  const to = options.to === null ? (chunks[0] ? chunks[0].end : from + 20) : options.to;
  const wanted = chunks.filter((chunk) => chunk.end > from && chunk.start < to);
  console.log(`${chunks.length} chunks, ${wanted.length} of them in ${from} to ${to} s`);
  fs.mkdirSync(options.out, { recursive: true });
  const cli = process.env.HYPERFRAMES_CLI;
  const env = { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_SKIP_SKILLS: '1', PRODUCER_EXPERIMENTAL_FAST_CAPTURE: 'false' };
  for (const chunk of wanted) {
    const dir = path.join(options.out, `chunk-${chunk.index + 1}`);
    fs.mkdirSync(path.join(dir, 'compositions'), { recursive: true });
    fs.copyFileSync(path.join(root, 'render-node', 'template', 'hyperframes.json'), path.join(dir, 'hyperframes.json'));
    // the footage of the chunk: exactly its frames, 1920x1080, 24 fps, no sound
    run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(chunk.start - graphics.start), '-i', footage, '-t', String(chunk.clipSeconds), '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,setsar=1', '-an', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', path.join(dir, 'vid-001.mp4')]);
    fs.writeFileSync(path.join(dir, 'index.html'), composition.buildChunkHtml({ graphics, chunk, clipFile: 'vid-001.mp4', options: { karaoke: options.karaoke, effects: options.effects } }));
    console.log(`chunk ${chunk.index + 1}: ${chunk.start.toFixed(2)} to ${chunk.end.toFixed(2)} s (${chunk.duration.toFixed(2)} s of page) -> ${dir}`);
    if (cli) {
      const started = Date.now();
      run(process.execPath, [cli, 'render', dir, '-o', path.join(dir, 'out.mp4'), '-q', options.quality, '-f', '24'], { env });
      console.log(`  rendered in ${((Date.now() - started) / 1000).toFixed(1)} s: ${path.join(dir, 'out.mp4')}`);
    }
  }
  if (!cli) console.log('HYPERFRAMES_CLI is not set: the projects are written, nothing is rendered.');
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
