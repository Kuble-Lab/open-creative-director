'use strict';

// Starter templates of the node view (SPEC §15): all of them load and validate against the registry, texts
// exist in de/en/es (Swiss spelling), `requires` covers the node types, the localized documents create
// workflows through the real routes, and the batch template maps a text list through the engine (with
// fake executors derived from the real node definitions, so no provider is contacted).

const assert = require('assert/strict');
const express = require('express');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const higgsfieldLib = require('../lib/higgsfield');
const falLib = require('../lib/fal');
const templates = require('../lib/nodes/templates');
const nodeRegistry = require('../lib/nodes/registry');
const { createRegistry } = nodeRegistry;
const { createEventBus } = require('../lib/nodes/events');
const { createWorkflowsStore, validateDocument } = require('../lib/nodes/workflows-store');
const { createEngine } = require('../lib/nodes/engine');
const { registerNodeRoutes } = require('../lib/nodes/routes');
const nodesBasic = require('../lib/nodes/nodes-basic');
const { textValue, listValue } = require('../lib/nodes/types');

const EXPECTED = [
  'dub-clip',
  'explainer-script',
  'explainer-script-topic',
  'explainer-video',
  'explainer-video-presenter',
  'explainer-video-topic',
  'frame-chain',
  'hero-variants',
  'image-formats',
  'image-to-ad',
  'image-to-video',
  'masked-edit',
  'motion-title',
  'motion-video-storyboard',
  'music-video',
  'music-video-hud',
  'music-video-hud-elevenlabs',
  'music-video-stills',
  'photo-slideshow',
  'photo-to-3d',
  'replace-people-in-video',
  'series-shots',
  'song-from-idea',
  'storyboard-clips',
  'suno-song-pack',
  'talking-portrait',
  'text-on-video',
  'typography-video',
  'typography-video-text',
  'video-cutout-overlay',
  'video-to-post',
  'video-with-music'
];
// the ones that work without Higgsfield (credits): what participants and guests get
const FOR_PARTICIPANTS = EXPECTED.filter((id) => id !== 'dub-clip');
const FREE = ['image-formats', 'photo-slideshow', 'text-on-video'];

// requirement keys that a node type needs (mirrors the availability predicates of the node modules)
function requirementsOf(type) {
  const keys = [];
  if (type.startsWith('llm.')) keys.push('openrouter');
  else if (['image.generate', 'image.edit', 'image.relight', 'video.seedance', 'video.generate'].includes(type)) keys.push('openrouter');
  else if (type === 'music_video.plan' || type === 'music_video.hud_plan') keys.push('openrouter', 'ffmpeg');
  else if (type === 'music_video.hud_render') keys.push('rendernode', 'ffmpeg');
  else if (type === 'explainer.plan') keys.push('openrouter');
  else if (type === 'explainer.voice') keys.push('elevenlabs', 'ffmpeg');
  else if (type === 'explainer.scene') keys.push('openrouter', 'rendernode', 'ffmpeg');
  else if (type === 'doc.read') keys.push('poppler');
  else if (['audio.tts', 'audio.music', 'audio.music_plan', 'audio.lyrics_timing'].includes(type)) keys.push('elevenlabs');
  else if (type.startsWith('fal.')) keys.push('fal');
  else if (type === 'video.motion_graphics') keys.push('rendernode');
  else if (type.startsWith('hf.') || ['image.higgsfield', 'video.higgsfield'].includes(type)) keys.push('higgsfield');
  const def = nodeRegistry.get(type);
  if (def && ['edit-image', 'edit-video', 'edit-audio'].includes(def.category)) keys.push('ffmpeg');
  if (['video.concat', 'llm.video_describer', 'audio.beats'].includes(type)) keys.push('ffmpeg');
  return keys;
}

function get(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out));
  return out;
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocd-nodes-templates-'));
  const createdSessions = [];
  const wfStore = createWorkflowsStore({ dir: tmpDir });
  const createdWorkflows = [];
  let server = null;

  try {
    /* ----- the templates exist, load and validate ----- */
    const all = templates.loadTemplates();
    assert.deepEqual(all.map((template) => template.id).sort(), EXPECTED);
    for (const template of all) {
      const result = templates.validateTemplate(template);
      assert.ok(result.graph.nodes.length >= 4, `${template.id} has a real graph`);
      assert.ok(result.app.enabled && result.app.inputs.length && result.app.outputs.length, `${template.id} ships a Design App`);
      assert.ok(result.graph.nodes.some((node) => node.type === 'output.result'), `${template.id} has an output node`);
      assert.ok(result.graph.notes.length >= 1, `${template.id} explains itself with a note`);
      assert.ok(template.description.length > 20);

      // every node type of the template is covered by `requires`
      const needed = new Set(result.graph.nodes.flatMap((node) => requirementsOf(node.type)));
      for (const key of needed) assert.ok(template.requires.includes(key), `${template.id}: requires must include ${key}`);
      for (const key of template.requires) assert.ok(needed.has(key), `${template.id}: requires lists ${key} but no node needs it`);

      // exposed media/text inputs must be inputs of the graph or generation params that exist
      for (const entry of result.app.inputs) {
        const node = result.graph.nodes.find((item) => item.id === entry.node);
        assert.ok(node, `${template.id}: app input node ${entry.node}`);
        const def = nodeRegistry.get(node.type);
        assert.ok(def.params.some((param) => param.id === entry.param), `${template.id}: ${node.type} has no param ${entry.param}`);
        assert.ok(entry.label.length > 2);
      }
      for (const entry of result.app.outputs) {
        assert.equal(result.graph.nodes.find((item) => item.id === entry.node).type, 'output.result');
      }
      // an output "shown first for approval" is `approve: true` in the file (any other value would be dropped silently by the import)
      for (const [index, entry] of template.app.outputs.entries()) {
        if (entry.approve !== undefined) assert.equal(entry.approve, true, `${template.id}: approve is true or not there`);
        assert.equal(result.app.outputs[index].approve, entry.approve, `${template.id}: the mark of output ${entry.node} survives the import`);
      }
    }

    // specific graph shapes the spec promises
    const byId = Object.fromEntries(all.map((template) => [template.id, template]));
    const types = (id) => byId[id].graph.nodes.map((node) => node.type);
    // the app view makes the marked outputs first and asks for the approval before the rest (SPEC §14): the motion video with
    // storyboard marks its Storyboard (n8) and its Script (n13); the two music videos in the HUD style (WP44) mark the board, the character
    // sheet and the three lists of pictures (n20 to n24; the second also its song, n29), so the person sees the plan, the figure and the pictures
    // before the lip sync and the clips are paid. No other template asks for it
    const markedIn = (app) => app.outputs.filter((entry) => entry.approve === true).map((entry) => entry.node);
    const MARKED = {
      'motion-video-storyboard': ['n8', 'n13'],
      'music-video-hud': ['n20', 'n21', 'n22', 'n23', 'n24'],
      'music-video-hud-elevenlabs': ['n29', 'n20', 'n21', 'n22', 'n23', 'n24']
    };
    assert.deepEqual(Object.fromEntries(all.map((template) => [template.id, markedIn(template.app)]).filter(([, nodes]) => nodes.length)), MARKED);
    for (const lang of ['en', 'de', 'es']) {
      for (const [id, nodes] of Object.entries(MARKED)) assert.deepEqual(markedIn(templates.resolveTemplate(id, { lang }).app), nodes, `${id} ${lang}: the marks are in the localized document`);
    }
    assert.deepEqual(types('hero-variants'), ['input.text', 'llm.prompt_enhancer', 'image.generate', 'image.resize', 'output.result']);
    assert.equal(byId['hero-variants'].graph.nodes.find((node) => node.type === 'image.generate').params.count, 4);
    assert.ok(types('image-to-ad').includes('llm.image_describer') && types('image-to-ad').includes('audio.tts') && types('image-to-ad').includes('video.merge_audio'));
    // a new workflow starts with the default speech model (Eleven v4), like a new node
    const speechNodes = all.flatMap((template) => template.graph.nodes.filter((item) => item.type === 'audio.tts').map((item) => ({ id: template.id, params: item.params })));
    assert.deepEqual(speechNodes.map((item) => item.id).sort(), ['image-to-ad', 'talking-portrait']);
    for (const item of speechNodes) assert.equal(item.params.model_id, 'eleven_v4', `${item.id}: the voice speaks with the default model`);
    assert.ok(types('series-shots').includes('input.text_list') && types('series-shots').includes('video.concat'));
    assert.ok(byId['series-shots'].graph.nodes.find((node) => node.type === 'input.text_list').params.text.split('\n').length === 3);
    assert.ok(types('frame-chain').filter((type) => type === 'video.seedance').length === 2 && types('frame-chain').includes('video.extract_frame'));
    assert.equal(byId['frame-chain'].graph.nodes.find((node) => node.type === 'video.extract_frame').params.position, 'last');
    assert.ok(types('motion-title').includes('llm.motion_html') && types('motion-title').includes('video.motion_graphics') && types('motion-title').includes('input.video'));
    assert.ok(types('masked-edit').includes('image.mask_apply') && types('masked-edit').includes('image.composite'));
    // dub-clip: one source video fans out to three dubbing nodes (deu, fra, ita) that all feed the result node
    assert.deepEqual(types('dub-clip'), ['input.video', 'hf.dubbing', 'hf.dubbing', 'hf.dubbing', 'output.result']);
    assert.deepEqual(byId['dub-clip'].graph.nodes.filter((node) => node.type === 'hf.dubbing').map((node) => node.params.target_language), ['deu', 'fra', 'ita']);
    assert.deepEqual(byId['dub-clip'].requires, ['higgsfield']);
    assert.deepEqual(byId['dub-clip'].graph.edges.filter((edge) => edge.from.node === 'n1').map((edge) => edge.to.node), ['n2', 'n3', 'n4']);
    assert.deepEqual(byId['dub-clip'].graph.edges.filter((edge) => edge.to.node === 'n5').map((edge) => edge.from.node), ['n2', 'n3', 'n4']);
    assert.equal(templates.resolveTemplate('dub-clip', { lang: 'de' }).name, 'Clip in drei Landessprachen');
    // talking-portrait: portrait + script -> ElevenLabs voice -> H3 Max lip sync on fal.ai -> result
    assert.deepEqual(types('talking-portrait'), ['input.image', 'input.text', 'audio.tts', 'fal.h3_lipsync', 'output.result']);
    assert.deepEqual(byId['talking-portrait'].requires, ['fal', 'elevenlabs']);
    assert.deepEqual(
      byId['talking-portrait'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n2.text>n3.text', 'n1.image>n4.image', 'n3.audio>n4.audio', 'n4.video>n5.inputs']
    );
    assert.equal(byId['talking-portrait'].app.enabled, true);
    assert.deepEqual(byId['talking-portrait'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.text', 'n4.resolution']);
    assert.equal(templates.resolveTemplate('talking-portrait', { lang: 'de' }).name, 'Sprechendes Porträt (H3 Max Lip Sync)');
    assert.equal(templates.resolveTemplate('talking-portrait', { lang: 'en' }).name, 'Talking portrait (H3 Max lip sync)');
    assert.ok(/Retrato parlante/.test(templates.resolveTemplate('talking-portrait', { lang: 'es' }).name));
    // video-with-music: the video sets the length of the music, the music is mixed quietly under the original sound
    assert.deepEqual(types('video-with-music'), ['input.video', 'input.prompt', 'audio.music', 'video.merge_audio', 'output.result']);
    assert.deepEqual(byId['video-with-music'].requires, ['elevenlabs', 'ffmpeg']);
    assert.deepEqual(
      byId['video-with-music'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n2.prompt>n3.prompt', 'n1.video>n3.match', 'n1.video>n4.video', 'n3.audio>n4.audio', 'n4.video>n5.inputs']
    );
    const mix = byId['video-with-music'].graph.nodes.find((node) => node.type === 'video.merge_audio').params;
    assert.equal(mix.mode, 'mix');
    assert.ok(mix.audio_volume < mix.video_volume, 'the music is quieter than the original sound');
    assert.deepEqual(byId['video-with-music'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.prompt', 'n3.instrumental', 'n4.audio_volume']);
    assert.equal(templates.resolveTemplate('video-with-music', { lang: 'de' }).name, 'Video mit Musik');
    // song-from-idea: idea -> song text -> music; the song text is the plan of the music node
    assert.deepEqual(types('song-from-idea'), ['input.prompt', 'audio.music_plan', 'audio.music', 'output.result']);
    assert.deepEqual(byId['song-from-idea'].requires, ['elevenlabs']);
    assert.deepEqual(
      byId['song-from-idea'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      ['n1.prompt>n2.prompt', 'n2.plan>n3.plan', 'n3.audio>n4.inputs']
    );
    assert.deepEqual(byId['song-from-idea'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n2.length']);
    assert.equal(templates.resolveTemplate('song-from-idea', { lang: 'es' }).name, 'Canción a partir de una idea');
    // the note of the song template names the command by its words in every language
    const songNote = (lang) => (lang === 'en' ? byId['song-from-idea'].graph.notes[0].text : byId['song-from-idea'].i18n[lang]['note.t1']);
    assert.match(songNote('en'), /Use as text/);
    assert.match(songNote('de'), /Als Text übernehmen/);
    assert.match(songNote('es'), /Usar como texto/);
    // music-video: song -> beats and lyric times -> plan -> images and clips for the story (H3 Max turbo) and for the singer (lip sync) -> cut
    // to the beat
    assert.deepEqual(types('music-video'), [
      'input.audio', 'input.image', 'audio.beats', 'audio.lyrics_timing', 'music_video.plan', 'text.template', 'text.template',
      'image.edit', 'image.edit', 'fal.h3_video', 'fal.h3_lipsync', 'music_video.edit', 'output.result'
    ]);
    assert.deepEqual(byId['music-video'].requires, ['openrouter', 'ffmpeg', 'elevenlabs', 'fal']);
    assert.deepEqual(
      byId['music-video'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      [
        'n1.audio>n3.audio', 'n1.audio>n4.audio', 'n3.analysis>n5.analysis', 'n4.timing>n5.timing', 'n1.audio>n5.song',
        'n5.story_prompts>n6.a', 'n5.performance_prompts>n7.a', 'n6.text>n8.prompt', 'n2.image>n8.images', 'n7.text>n9.prompt', 'n2.image>n9.images',
        'n8.image>n10.first_frame', 'n5.story_motion>n10.prompt', 'n9.image>n11.image', 'n5.performance_audio>n11.audio',
        'n1.audio>n12.song', 'n5.shots>n12.shots', 'n10.video>n12.story', 'n11.video>n12.performance', 'n12.video>n13.inputs', 'n4.timing>n12.captions'
      ]
    );
    {
      const musicNode = (id) => byId['music-video'].graph.nodes.find((node) => node.id === id);
      // the story clips are H3 Max turbo (768P, 5 s, 0.04 USD a second): Seedance refuses the images of the template, which show the person of
      // the photo (VIDEO_REAL_PERSON). A first run is cheap otherwise: the lip sync in 768P, few scenes, a share of singer scenes that is not the half
      assert.deepEqual(musicNode('n10').params, { prompt: '', model: 'turbo', resolution: '768P', aspect_ratio: '16:9', duration: 5, prompt_expansion: 'balanced', seed: null, safety: true });
      assert.deepEqual(nodeRegistry.normalizeParams(nodeRegistry.get('fal.h3_video'), musicNode('n10').params), musicNode('n10').params, 'every param is one of the node, with a valid value');
      assert.equal(nodeRegistry.get('fal.h3_video').cost.estimate(musicNode('n10').params), 0.2, 'a clip costs 5 s at 0.04 USD');
      assert.equal(musicNode('n11').params.resolution, '768P');
      assert.ok(musicNode('n5').params.shots_per_minute <= 10 && musicNode('n5').params.performance_share <= 0.3);
      // the pieces that have to agree: the clip length of the plan and of the video, the format of the plan and of both image nodes
      assert.equal(musicNode('n5').params.clip_seconds, musicNode('n10').params.duration);
      assert.deepEqual([musicNode('n5').params.aspect_ratio, musicNode('n8').params.aspect_ratio, musicNode('n9').params.aspect_ratio, musicNode('n10').params.aspect_ratio], ['16:9', '16:9', '16:9', '16:9']);
      assert.ok(musicNode('n8').params.count === 1 && musicNode('n9').params.count === 1, 'one image per scene');
      // the photo of the main person goes into both image nodes, and the text nodes say so
      assert.deepEqual(byId['music-video'].graph.edges.filter((edge) => edge.from.node === 'n2').map((edge) => `${edge.to.node}.${edge.to.port}`), ['n8.images', 'n9.images']);
      for (const id of ['n6', 'n7']) assert.match(musicNode(id).params.template, /reference photo/);
      assert.deepEqual(byId['music-video'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n2.asset', 'n5.brief', 'n4.lyrics', 'n5.characters', 'n5.shots_per_minute', 'n5.performance_share', 'n12.transition', 'n12.captions']);
      // karaoke captions at the bottom, from the lyric times: shipped off since 2026-10-09 (no burnt-in text unless asked for), the person
      // switches them on in the form (WP35)
      assert.equal(musicNode('n12').params.captions, 'off');
      assert.equal(musicNode('n12').params.captions_position, 'bottom');
      assert.deepEqual(nodeRegistry.normalizeParams(nodeRegistry.get('music_video.edit'), musicNode('n12').params), musicNode('n12').params, 'every param of the cut is one of the node, with a valid value');
      assert.equal(byId['music-video'].graph.nodes.find((node) => node.id === 'n4').type, 'audio.lyrics_timing');
      assert.equal(byId['music-video'].graph.edges.filter((edge) => edge.from.node === 'n4').length, 2, 'the times go to the plan and to the captions');
      assert.equal(musicNode('n5').params.brief, '', 'the idea is the one input only the person can give: it ships empty and the run asks for it');
      assert.match(byId['music-video'].description, /music video/i);
      assert.match(byId['music-video'].description, /US dollars/, 'the description names the cost');
      assert.match(byId['music-video'].description, /confirm/, 'and that nothing is charged before the confirmation');
      for (const lang of ['en', 'de', 'es']) {
        const description = templates.resolveTemplate('music-video', { lang }).description;
        assert.match(description, /H3 Max turbo/, `${lang}: the description names the model of the story clips`);
        assert.match(description, /Seedance/, `${lang}: and why it is not Seedance`);
        assert.equal(/480p/i.test(description), false, `${lang}: no word of the old video settings`);
      }
      assert.match(templates.resolveTemplate('music-video', { lang: 'de' }).graph.nodes.find((node) => node.id === 'n10').title, /Handlungsclips \(H3 Max turbo\)/);
      assert.match(templates.resolveTemplate('music-video', { lang: 'es' }).graph.nodes.find((node) => node.id === 'n10').title, /Clips de la historia \(H3 Max turbo\)/);
      assert.equal(byId['music-video'].graph.nodes.find((node) => node.id === 'n10').title, 'Story clips (H3 Max turbo)');
    }
    assert.equal(templates.resolveTemplate('music-video', { lang: 'de' }).name, 'Musikvideo aus Song');
    assert.equal(templates.resolveTemplate('music-video', { lang: 'en' }).name, 'Music video from a song');
    assert.match(templates.resolveTemplate('music-video', { lang: 'es' }).name, /Videoclip/);
    assert.match(templates.resolveTemplate('music-video', { lang: 'de' }).description, /Musikvideo/);
    // music-video-stills (WP35): the same chain, but the story scenes are moved by the local zoom (free) instead of H3 Max clips; the singer
    // scenes keep the lip sync
    assert.deepEqual(types('music-video-stills'), [
      'input.audio', 'input.image', 'audio.beats', 'audio.lyrics_timing', 'music_video.plan', 'text.template', 'text.template',
      'image.edit', 'image.edit', 'image.to_video', 'fal.depth_map', 'fal.h3_lipsync', 'music_video.edit', 'output.result'
    ]);
    assert.deepEqual(byId['music-video-stills'].requires, ['openrouter', 'ffmpeg', 'elevenlabs', 'fal']);
    assert.deepEqual(
      byId['music-video-stills'].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`),
      [
        'n1.audio>n3.audio', 'n1.audio>n4.audio', 'n3.analysis>n5.analysis', 'n4.timing>n5.timing', 'n1.audio>n5.song',
        'n5.story_prompts>n6.a', 'n5.performance_prompts>n7.a', 'n6.text>n8.prompt', 'n2.image>n8.images', 'n7.text>n9.prompt', 'n2.image>n9.images',
        'n8.image>n10.image', 'n9.image>n11.image', 'n5.performance_audio>n11.audio',
        'n1.audio>n12.song', 'n5.shots>n12.shots', 'n10.video>n12.story', 'n11.video>n12.performance', 'n12.video>n13.inputs', 'n4.timing>n12.captions',
        // the depth maps of the parallax switch: from the story images to the optional depth input of the zoom node
        'n8.image>n14.image', 'n14.depth>n10.depth'
      ]
    );
    {
      const stillsDoc = byId['music-video-stills'];
      const stillsNode = (id) => stillsDoc.graph.nodes.find((node) => node.id === id);
      // the zoom clip is as long as a scene of the plan can be and has the frame rate of the cut; the motion varies by the position of the
      // scene (zoom in, pan right, zoom out, pan left), and the depth maps are made only when the switch is on (default off)
      assert.deepEqual(stillsNode('n10').params, { duration: 5, match_audio: false, fps: 25, zoom: 'varied', parallax_strength: 30 });
      assert.deepEqual(stillsNode('n14').params, { enabled: false }, 'the parallax switch is off by default');
      assert.deepEqual(nodeRegistry.normalizeParams(nodeRegistry.get('image.to_video'), stillsNode('n10').params), stillsNode('n10').params, 'every param is one of the node, with a valid value');
      assert.equal(stillsNode('n10').params.duration, stillsNode('n5').params.clip_seconds, 'a zoom clip is as long as the clips of the plan');
      assert.equal(String(stillsNode('n10').params.fps), stillsNode('n12').params.fps, 'and has the frame rate of the cut');
      assert.equal(stillsDoc.graph.nodes.some((node) => node.type === 'fal.h3_video'), false, 'no paid clip is made for the story');
      assert.deepEqual(stillsDoc.graph.nodes.filter((node) => node.type.startsWith('fal.')).map((node) => node.type), ['fal.depth_map', 'fal.h3_lipsync']);
      assert.equal(stillsDoc.graph.edges.some((edge) => edge.from.port === 'story_motion'), false, 'the motion text of the plan has nobody to read it');
      // everything else is the template of the video clips
      for (const id of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n11', 'n12', 'n13']) {
        assert.deepEqual(stillsNode(id), byId['music-video'].graph.nodes.find((node) => node.id === id), `${id} is the same as in the template with video clips`);
      }
      // the form of the template with video clips plus the switch for the depth maps and the choice of the motion
      assert.deepEqual(stillsDoc.app.inputs.map((entry) => `${entry.node}.${entry.param}`), [...byId['music-video'].app.inputs.map((entry) => `${entry.node}.${entry.param}`), 'n14.enabled', 'n10.zoom']);
      // the figure in the description is what the price tables say: 28 images and four lip sync scenes of 7.5 s, nothing for the clips
      const imageModels = require('../lib/image-models');
      const images = 28 * imageModels.estimateUsd('google/gemini-3-pro-image');
      const lipSyncParams = nodeRegistry.normalizeParams(nodeRegistry.get('fal.h3_lipsync'), stillsNode('n11').params);
      const lipSync = 4 * nodeRegistry.get('fal.h3_lipsync').cost.estimate(lipSyncParams, { inputs: { audio: { type: 'audio', duration: 7.5 } } });
      assert.equal(Math.round(images * 100) / 100, 3.75);
      assert.equal(Math.round(lipSync * 100) / 100, 2.4);
      assert.equal(Math.round(images + lipSync + 0.05), 6, 'about 6 US dollars with the plan and the lyric times');
      for (const [lang, name, about, parts] of [
        ['en', 'Music video from a song (moving images)', /about 6 US dollars/, [/3\.75/, /2\.40/, /about 11/, /confirm/]],
        ['de', 'Musikvideo aus Song (bewegte Bilder)', /etwa 6 US-Dollar/, [/3\.75/, /2\.40/, /etwa 11/, /Bestätigung/]],
        ['es', null, /unos 6 dólares/, [/3,75/, /2,40/, /unos 11/, /confirmes/]]
      ]) {
        const resolved = templates.resolveTemplate('music-video-stills', { lang });
        if (name) assert.equal(resolved.name, name);
        else assert.match(resolved.name, /imágenes en movimiento/);
        assert.match(resolved.description, about, `${lang}: the description names the cost of a 2-minute song`);
        for (const part of parts) assert.match(resolved.description, part, `${lang}: ${part}`);
        assert.equal(/H3 Max turbo/.test(resolved.description), false, `${lang}: no clip model is paid here`);
        assert.match(resolved.graph.nodes.find((node) => node.id === 'n10').title, lang === 'en' ? /slow zoom/ : lang === 'de' ? /langsamer Zoom/ : /zoom lento/);
      }
    }
    // music-video-hud (WP44): song -> beats and lyric times -> HUD plan -> character sheet -> pictures of the three kinds of units (sung, story,
    // still) with the sheet as reference -> lip sync, H3 Max turbo clips and the parallax of the stills -> cut to the beat without captions ->
    // HUD render. The board, the sheet and the three lists of pictures are marked: they are shown for the approval before the clips are paid
    assert.deepEqual(types('music-video-hud'), [
      'input.audio', 'audio.beats', 'audio.lyrics_timing', 'music_video.hud_plan', 'image.generate', 'text.template', 'text.template', 'text.template',
      'image.edit', 'image.edit', 'image.edit', 'fal.h3_lipsync', 'fal.h3_video', 'fal.depth_map', 'image.to_video', 'music_video.edit', 'music_video.hud_render',
      'output.result', 'output.result', 'output.result', 'output.result', 'output.result', 'output.result', 'output.result'
    ]);
    assert.deepEqual(byId['music-video-hud'].requires, ['openrouter', 'ffmpeg', 'elevenlabs', 'fal', 'rendernode']);
    const HUD_CHAIN_EDGES = [
      'n1.audio>n2.audio', 'n1.audio>n3.audio', 'n2.analysis>n4.analysis', 'n3.timing>n4.timing', 'n1.audio>n4.song',
      'n4.sheet_prompt>n5.prompt', 'n4.performance_prompts>n6.a', 'n4.story_prompts>n7.a', 'n4.still_prompts>n8.a',
      'n6.text>n9.prompt', 'n5.image>n9.images', 'n7.text>n10.prompt', 'n5.image>n10.images', 'n8.text>n11.prompt', 'n5.image>n11.images',
      'n9.image>n12.image', 'n4.performance_audio>n12.audio', 'n10.image>n13.first_frame', 'n4.story_motion>n13.prompt',
      'n11.image>n14.image', 'n11.image>n15.image', 'n14.depth>n15.depth',
      'n1.audio>n16.song', 'n4.shots>n16.shots', 'n13.video>n16.story', 'n12.video>n16.performance', 'n15.video>n16.still_clips',
      'n16.video>n17.video', 'n1.audio>n17.audio', 'n4.graphics>n17.graphics',
      'n17.video>n18.inputs', 'n17.sheet>n19.inputs', 'n4.board>n20.inputs', 'n5.image>n21.inputs', 'n9.image>n22.inputs', 'n10.image>n23.inputs', 'n11.image>n24.inputs'
    ];
    const edgesOf = (id) => byId[id].graph.edges.map((edge) => `${edge.from.node}.${edge.from.port}>${edge.to.node}.${edge.to.port}`);
    assert.deepEqual(edgesOf('music-video-hud'), HUD_CHAIN_EDGES);
    {
      const hudDoc = byId['music-video-hud'];
      const hudNode = (id) => hudDoc.graph.nodes.find((node) => node.id === id);
      // every param of every node is one of the node with a valid value (nothing is dropped by the import)
      for (const node of hudDoc.graph.nodes) assert.deepEqual(nodeRegistry.normalizeParams(nodeRegistry.get(node.type), node.params), node.params, `${node.id} (${node.type}): every param is one of the node, with a valid value`);
      // Nano Banana 2.1 is set on the node of the character sheet and on every node of the pictures (the choice of the owner, not the default of the
      // settings); the sheet is a portrait (the prompt is a head-and-shoulders portrait), the pictures are 16:9, one per unit
      for (const id of ['n5', 'n9', 'n10', 'n11']) assert.equal(hudNode(id).params.model, 'google/gemini-nano-banana-2.1', `${id}: Nano Banana 2.1`);
      assert.deepEqual([hudNode('n5').params.aspect_ratio, hudNode('n5').params.count], ['3:4', 1]);
      for (const id of ['n9', 'n10', 'n11']) assert.deepEqual([hudNode(id).params.aspect_ratio, hudNode(id).params.count], ['16:9', 1], `${id}: 16:9, one picture per unit`);
      assert.equal(hudDoc.graph.nodes.filter((node) => node.type === 'image.generate' || node.type === 'image.edit').length, 4, 'no other picture node');
      // the character sheet goes into the three picture nodes as the reference, and the three text nodes in front of them say what it is
      assert.deepEqual(hudDoc.graph.edges.filter((edge) => edge.from.node === 'n5' && edge.to.port === 'images').map((edge) => edge.to.node), ['n9', 'n10', 'n11']);
      for (const id of ['n6', 'n7', 'n8']) assert.match(hudNode(id).params.template, /^The attached image is the character sheet of the main person\..*\{\{a\}\}$/, `${id}: the prefix names the sheet and keeps the prompt`);
      // the pieces that have to agree: the clip length of the plan is the duration of the story clips and of the parallax clips; their frame rate is the one of the cut
      assert.equal(hudNode('n4').params.clip_seconds, 5);
      assert.equal(hudNode('n13').params.duration, hudNode('n4').params.clip_seconds);
      assert.equal(hudNode('n15').params.duration, hudNode('n4').params.clip_seconds);
      assert.equal(String(hudNode('n15').params.fps), hudNode('n16').params.fps);
      // the story clips are H3 Max turbo, like the template with video clips; the lip sync is 768P
      assert.deepEqual(hudNode('n13').params, { prompt: '', model: 'turbo', resolution: '768P', aspect_ratio: '16:9', duration: 5, prompt_expansion: 'balanced', seed: null, safety: true });
      assert.equal(hudNode('n12').params.resolution, '768P');
      // the stills move by the parallax of their depth maps
      assert.deepEqual([hudNode('n14').params.enabled, hudNode('n15').params.zoom, hudNode('n15').params.match_audio], [true, 'parallax_in', false]);
      // the base cut: hard cuts, 1080p, 24 frames per second, no captions anywhere (the HUD draws the words) and no fade (the film goes on in the render)
      assert.deepEqual(hudNode('n16').params, { transition: 'cut', resolution: '1080p', fps: '24', fit: 'crop', fade_out: 0, captions: 'off', captions_position: 'bottom' });
      assert.equal(hudDoc.graph.edges.some((edge) => edge.to.node === 'n16' && edge.to.port === 'captions'), false, 'no lyric times go into the cut');
      // the render takes the style of the plan (auto), the karaoke line is off, standard quality, with the end card
      assert.deepEqual(hudNode('n17').params, { theme: 'auto', accent: '#3B82F6', karaoke: false, grain: 0.35, glitch: 0.6, endcard: true, quality: 'standard' });
      // the planner: HUD Blue, the default model, the figure Claudia (the canon text; word for word in test-music-video-hud-template.js), the idea ships empty
      assert.deepEqual([hudNode('n4').params.theme, hudNode('n4').params.model, hudNode('n4').params.brief, hudNode('n4').params.hud_language], ['hud', '', '', 'en']);
      assert.match(hudNode('n4').params.figure, /^NAME: Claudia\nFULL: a 28-year-old /);
      assert.match(hudNode('n4').params.figure, /\nSHORT: a Caucasian American woman in her late twenties /);
      assert.match(hudNode('n4').params.figure, /\nCREDIT: Claudia by anabology \(claudia\.gallery\)$/);
      // the lyric times: optional text, the method decides (auto)
      assert.deepEqual(hudNode('n3').params, { lyrics: '', method: 'auto' });
      // the form: the song, the idea, the figure, the style, the lyrics, the karaoke line (and the language of the graphics); the film first, then the
      // contact sheet, then the marked outputs
      assert.deepEqual(hudDoc.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.asset', 'n4.brief', 'n4.figure', 'n4.theme', 'n3.lyrics', 'n17.karaoke', 'n4.hud_language']);
      assert.deepEqual(hudDoc.app.outputs.map((entry) => entry.node), ['n18', 'n19', 'n20', 'n21', 'n22', 'n23', 'n24']);
      const labelOf = (lang, node, param) => templates.resolveTemplate('music-video-hud', { lang }).app.inputs.find((entry) => entry.node === node && entry.param === param).label;
      assert.deepEqual([labelOf('en', 'n4', 'theme'), labelOf('de', 'n4', 'theme'), labelOf('es', 'n4', 'theme')], ['Style', 'Stil', 'Estilo']);
      assert.deepEqual([labelOf('en', 'n17', 'karaoke'), labelOf('de', 'n17', 'karaoke')], ['Subtitles (karaoke line)', 'Untertitel (Karaoke-Zeile)']);
      assert.equal(templates.resolveTemplate('music-video-hud', { lang: 'de' }).name, 'Musikvideo im HUD-Stil (eigener Song)');
      assert.equal(templates.resolveTemplate('music-video-hud', { lang: 'en' }).name, 'Music video in the HUD style (your song)');
      assert.match(templates.resolveTemplate('music-video-hud', { lang: 'es' }).name, /Videoclip en estilo HUD/);
    }

    // music-video-hud-elevenlabs: the same film, but the song comes from the idea. The idea and the voice are one request; the song text and
    // structure (free of credits) feeds the music, the analysis (the sections) and the lyric times; the music is 90 seconds by default
    assert.deepEqual(types('music-video-hud-elevenlabs'), [
      'input.prompt', 'input.text', 'text.template', 'audio.music_plan', 'audio.music', 'output.result', 'audio.beats', 'audio.lyrics_timing', 'music_video.hud_plan',
      'image.generate', 'text.template', 'text.template', 'text.template', 'image.edit', 'image.edit', 'image.edit', 'fal.h3_lipsync', 'fal.h3_video', 'fal.depth_map',
      'image.to_video', 'music_video.edit', 'music_video.hud_render', 'output.result', 'output.result', 'output.result', 'output.result', 'output.result', 'output.result', 'output.result'
    ]);
    assert.deepEqual(byId['music-video-hud-elevenlabs'].requires, ['openrouter', 'ffmpeg', 'elevenlabs', 'fal', 'rendernode']);
    assert.deepEqual(edgesOf('music-video-hud-elevenlabs'), [
      ...HUD_CHAIN_EDGES, 'n25.prompt>n27.a', 'n26.text>n27.b', 'n27.text>n28.prompt', 'n28.plan>n1.plan', 'n28.plan>n2.plan', 'n28.plan>n3.lyrics', 'n25.prompt>n4.brief', 'n1.audio>n29.inputs'
    ]);
    {
      const elevenDoc = byId['music-video-hud-elevenlabs'];
      const elevenNode = (id) => elevenDoc.graph.nodes.find((node) => node.id === id);
      for (const node of elevenDoc.graph.nodes) assert.deepEqual(nodeRegistry.normalizeParams(nodeRegistry.get(node.type), node.params), node.params, `${node.id} (${node.type}): every param is one of the node, with a valid value`);
      // the chain from the analysis to the film is the one of the first template, node by node (only the place on the canvas differs)
      for (let number = 2; number <= 24; number += 1) {
        const [a, b] = [byId['music-video-hud'], elevenDoc].map((doc) => doc.graph.nodes.find((node) => node.id === `n${number}`));
        assert.deepEqual({ type: b.type, params: b.params, title: b.title }, { type: a.type, params: a.params, title: a.title }, `n${number}`);
      }
      assert.deepEqual(elevenNode('n28').params, { prompt: '', length: 90, model: 'music_v2_5' });
      assert.deepEqual(elevenNode('n1').params, { prompt: '', plan: '', length: 30, instrumental: false, model: 'music_v2_5' }, 'the song text sets the length of the music, with vocals');
      assert.match(elevenNode('n26').params.text, /deadpan, clipped spoken verses rising into euphoric sung choruses/, 'the voice of the default figure');
      assert.equal(elevenNode('n25').params.prompt, '', 'the idea is the one input only the person can give');
      assert.deepEqual(elevenDoc.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n25.prompt', 'n28.length', 'n26.text', 'n4.figure', 'n4.theme', 'n17.karaoke', 'n4.hud_language']);
      assert.deepEqual(elevenDoc.app.outputs.map((entry) => entry.node), ['n18', 'n19', 'n29', 'n20', 'n21', 'n22', 'n23', 'n24']);
      assert.equal(templates.resolveTemplate('music-video-hud-elevenlabs', { lang: 'de' }).name, 'Musikvideo im HUD-Stil (Song von ElevenLabs)');
      assert.equal(templates.resolveTemplate('music-video-hud-elevenlabs', { lang: 'en' }).name, 'Music video in the HUD style (song by ElevenLabs)');
    }

    // suno-song-pack: idea and singer -> one request -> Claude Opus 5.5 with the system prompt of the pack (word for word in
    // test-music-video-hud-template.js) -> a text to copy into Suno. Nothing to approve, no film: the description says where the song goes next
    assert.deepEqual(types('suno-song-pack'), ['input.prompt', 'input.text', 'text.template', 'llm.chat', 'output.result']);
    assert.deepEqual(byId['suno-song-pack'].requires, ['openrouter']);
    assert.deepEqual(edgesOf('suno-song-pack'), ['n1.prompt>n3.a', 'n2.text>n3.b', 'n3.text>n4.prompt', 'n4.text>n5.inputs']);
    {
      const sunoDoc = byId['suno-song-pack'];
      const sunoNode = (id) => sunoDoc.graph.nodes.find((node) => node.id === id);
      // like the other templates with a language model, the chat node names only model, system prompt and prompt: the rest is the default
      for (const node of sunoDoc.graph.nodes) {
        const normalized = nodeRegistry.normalizeParams(nodeRegistry.get(node.type), node.params);
        for (const [key, value] of Object.entries(node.params)) assert.deepEqual(normalized[key], value, `${node.id} (${node.type}): ${key} is a param of the node, with a valid value`);
      }
      assert.deepEqual(Object.keys(sunoNode('n4').params), ['model', 'system', 'prompt']);
      assert.equal(sunoNode('n4').params.model, 'anthropic/claude-opus-5.5');
      assert.match(sunoNode('n2').params.text, /^Claudia, an adult AI pop singer/, 'the default singer is the persona of Claudia, an adult');
      assert.equal(sunoNode('n1').params.prompt, '', 'the idea is the one input only the person can give');
      assert.deepEqual(sunoDoc.app.inputs.map((entry) => `${entry.node}.${entry.param}`), ['n1.prompt', 'n2.text']);
      assert.deepEqual(sunoDoc.app.outputs.map((entry) => entry.node), ['n5']);
      assert.equal(templates.resolveTemplate('suno-song-pack', { lang: 'de' }).name, 'Suno-Songpaket');
      assert.equal(templates.resolveTemplate('suno-song-pack', { lang: 'en' }).name, 'Suno song pack');
      assert.match(templates.resolveTemplate('suno-song-pack', { lang: 'es' }).name, /Suno/);
    }

    // frame-chain: the clip edges into concat are in playback order
    const concatEdges = byId['frame-chain'].graph.edges.filter((edge) => edge.to.port === 'clips');
    assert.deepEqual(concatEdges.map((edge) => edge.from.node), ['n2', 'n5']);

    /* ----- localization: de/en/es complete, Swiss spelling ----- */
    for (const template of all) {
      const i18n = template.i18n || {};
      const en = templates.localizeTemplate(template, 'en');
      assert.equal(en.name, template.name);
      assert.equal(en.i18n, undefined, 'the i18n block is not part of the workflow document');
      const expectedKeys = new Set(['name', 'description', 'app.title', 'app.description']);
      for (const node of template.graph.nodes) if (node.title) expectedKeys.add(`node.${node.id}`);
      for (const note of template.graph.notes) expectedKeys.add(`note.${note.id}`);
      for (const group of template.graph.groups) expectedKeys.add(`group.${group.id}`);
      for (const entry of template.app.inputs) expectedKeys.add(`app.input.${entry.node}.${entry.param}`);
      for (const entry of template.app.outputs) expectedKeys.add(`app.output.${entry.node}`);
      for (const lang of ['de', 'es']) {
        const strings = i18n[lang];
        assert.ok(strings, `${template.id} has ${lang} texts`);
        for (const key of expectedKeys) assert.ok(typeof strings[key] === 'string' && strings[key].trim(), `${template.id}.${lang} misses ${key}`);
        for (const key of Object.keys(strings)) {
          const valid = expectedKeys.has(key) || /^param\.[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/.test(key);
          assert.ok(valid, `${template.id}.${lang} has an unknown key ${key}`);
          if (key.startsWith('param.')) {
            const [, nodeId, paramId] = key.split('.');
            assert.equal(typeof template.graph.nodes.find((node) => node.id === nodeId).params[paramId], 'string', `${key} overrides a string param`);
          }
        }
        const localized = templates.localizeTemplate(template, lang);
        assert.notEqual(localized.name, template.name);
        validateDocument({ format: 'ocd.workflow', version: 1, name: localized.name, description: localized.description, graph: localized.graph, app: localized.app });
        for (const text of collectStrings(localized)) assert.equal(text.includes('ß'), false, `${template.id}.${lang}: no sharp s (${text.slice(0, 40)})`);
      }
      // unknown languages fall back to English
      assert.equal(templates.localizeTemplate(template, 'fr').name, template.name);
      assert.equal(templates.pickLang('DE-CH'), 'de');
    }

    /* ----- listing and availability ----- */
    {
      const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
      const listed = templates.listTemplates({ lang: 'de', checks: allOn });
      assert.deepEqual(listed.map((item) => item.id).sort(), EXPECTED);
      assert.ok(listed.every((item) => item.available && item.missing.length === 0));
      const noAudio = templates.listTemplates({ lang: 'en', checks: { ...allOn, elevenlabs: () => 'ELEVENLABS_API_KEY is not set' } });
      const ad = noAudio.find((item) => item.id === 'image-to-ad');
      assert.equal(ad.available, false);
      assert.deepEqual(ad.missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.ok(noAudio.filter((item) => !['image-to-ad', 'talking-portrait', 'video-with-music', 'song-from-idea', 'music-video', 'music-video-stills', 'music-video-hud', 'music-video-hud-elevenlabs', 'explainer-video', 'explainer-video-topic', 'explainer-video-presenter', 'typography-video', 'typography-video-text', 'motion-video-storyboard'].includes(item.id)).every((item) => item.available));
      // the explainer videos (and the two typography videos, WP40) speak with ElevenLabs
      for (const id of ['explainer-video', 'explainer-video-topic', 'explainer-video-presenter', 'typography-video', 'typography-video-text', 'motion-video-storyboard']) {
        assert.deepEqual(noAudio.find((item) => item.id === id).missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }], `${id}: the voice comes from ElevenLabs`);
      }
      // the music templates need the ElevenLabs key, and ffmpeg where the video is mixed
      assert.deepEqual(noAudio.find((item) => item.id === 'song-from-idea').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.deepEqual(noAudio.find((item) => item.id === 'video-with-music').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.deepEqual(noAudio.find((item) => item.id === 'talking-portrait').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.deepEqual(noAudio.find((item) => item.id === 'music-video').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }], 'the lyric times come from ElevenLabs');
      assert.deepEqual(noAudio.find((item) => item.id === 'music-video-stills').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }], 'so do they in the variant with moving images');
      // WP44: the lyric times of the HUD film come from ElevenLabs, and so does the music of the one that makes its own song; the Suno pack needs the language model only
      assert.deepEqual(noAudio.find((item) => item.id === 'music-video-hud').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.deepEqual(noAudio.find((item) => item.id === 'music-video-hud-elevenlabs').missing, [{ key: 'elevenlabs', reason: 'ELEVENLABS_API_KEY is not set' }]);
      assert.equal(noAudio.find((item) => item.id === 'suno-song-pack').available, true);
      // Higgsfield is a requirement of its own: a template with hf.* nodes is available exactly when Higgsfield is connected
      const noHiggsfield = templates.listTemplates({ lang: 'en', checks: { ...allOn, higgsfield: () => 'Higgsfield is not connected' } });
      const dub = noHiggsfield.find((item) => item.id === 'dub-clip');
      assert.equal(dub.available, false);
      assert.deepEqual(dub.missing, [{ key: 'higgsfield', reason: 'Higgsfield is not connected' }]);
      assert.deepEqual(dub.requires, ['higgsfield']);
      assert.ok(noHiggsfield.filter((item) => item.id !== 'dub-clip').every((item) => item.available));
      // fal.ai is a requirement of its own: available exactly when FAL_KEY is set
      const noFal = templates.listTemplates({ lang: 'en', checks: { ...allOn, fal: () => 'FAL_KEY is not set' } });
      const portrait = noFal.find((item) => item.id === 'talking-portrait');
      assert.equal(portrait.available, false);
      assert.deepEqual(portrait.missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }]);
      assert.deepEqual(portrait.requires, ['fal', 'elevenlabs']);
      assert.ok(noFal.filter((item) => !['talking-portrait', 'photo-to-3d', 'music-video', 'music-video-stills', 'music-video-hud', 'music-video-hud-elevenlabs', 'explainer-video-presenter', 'video-cutout-overlay', 'replace-people-in-video'].includes(item.id)).every((item) => item.available));
      assert.deepEqual(noFal.find((item) => item.id === 'explainer-video-presenter').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }], 'only the presenter needs fal.ai (the lip sync); the other two explainer videos run without it');
      assert.deepEqual(noFal.find((item) => item.id === 'music-video').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }], 'the story clips and the lip sync of the singer scenes run on fal.ai');
      assert.deepEqual(noFal.find((item) => item.id === 'music-video-stills').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }], 'the lip sync of the singer scenes still does');
      assert.deepEqual(noFal.find((item) => item.id === 'music-video-hud').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }], 'WP44: the lip sync, the story clips and the depth maps of the HUD film run on fal.ai');
      assert.deepEqual(noFal.find((item) => item.id === 'music-video-hud-elevenlabs').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }]);
      assert.equal(noFal.find((item) => item.id === 'suno-song-pack').available, true);
      // the HUD is drawn on a render node: the two films are not available without one, the Suno pack is
      const noRender = templates.listTemplates({ lang: 'en', checks: { ...allOn, rendernode: () => 'No render node configured' } });
      for (const id of ['music-video-hud', 'music-video-hud-elevenlabs']) {
        assert.deepEqual(noRender.find((item) => item.id === id).missing, [{ key: 'rendernode', reason: 'No render node configured' }], `${id}: the HUD needs a render node`);
      }
      assert.equal(noRender.find((item) => item.id === 'suno-song-pack').available, true);
      assert.equal(noRender.find((item) => item.id === 'music-video-stills').available, true, 'the older films are drawn without a render node');
      // the language model is a requirement of the films (the planner and the pictures) and of the Suno pack
      const noModel = templates.listTemplates({ lang: 'en', checks: { ...allOn, openrouter: () => 'OPENROUTER_API_KEY is not set' } });
      for (const id of ['music-video-hud', 'music-video-hud-elevenlabs', 'suno-song-pack']) assert.deepEqual(noModel.find((item) => item.id === id).missing, [{ key: 'openrouter', reason: 'OPENROUTER_API_KEY is not set' }], `${id}: needs the language model`);
      assert.equal(noFal.find((item) => item.id === 'photo-to-3d').available, false, 'photo to 3D needs only the fal.ai key');
      assert.deepEqual(noFal.find((item) => item.id === 'photo-to-3d').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }]);
      assert.deepEqual(noFal.find((item) => item.id === 'video-cutout-overlay').missing, [{ key: 'fal', reason: 'FAL_KEY is not set' }], 'the segmentation runs on fal.ai (WP33b)');
      const originalHasKey = falLib.hasKey;
      try {
        falLib.hasKey = () => true;
        assert.equal(templates.REQUIREMENT_CHECKS.fal(), true);
        falLib.hasKey = () => false;
        assert.match(templates.REQUIREMENT_CHECKS.fal(), /FAL_KEY/);
      } finally {
        falLib.hasKey = originalHasKey;
      }
      // the real check follows the connection state (mocked: no provider is contacted)
      const originalStatus = higgsfieldLib.status;
      try {
        higgsfieldLib.status = () => ({ connected: true });
        assert.equal(templates.REQUIREMENT_CHECKS.higgsfield(), true);
        higgsfieldLib.status = () => ({ connected: false });
        assert.match(templates.REQUIREMENT_CHECKS.higgsfield(), /Higgsfield/);
      } finally {
        higgsfieldLib.status = originalStatus;
      }
      assert.equal(noAudio.find((item) => item.id === 'series-shots').batch, true);
      assert.equal(noAudio.find((item) => item.id === 'hero-variants').batch, false);
      assert.equal(templates.listTemplates({ lang: 'de', checks: allOn }).find((item) => item.id === 'hero-variants').name, 'Produkt-Hero, 4 Varianten');
      assert.equal(templates.resolveTemplate('nope'), null);
      assert.equal(templates.resolveTemplate('hero-variants', { lang: 'es' }).graph.nodes[0].title, 'Escena de producto');
      // the real checks answer true or a reason string
      for (const item of templates.listTemplates()) assert.ok(typeof item.available === 'boolean');
    }

    /* ----- order, new templates, participants, cost, flow ----- */
    {
      assert.deepEqual([...templates.ORDER].sort(), EXPECTED, 'ORDER lists every template once and nothing else');
      assert.deepEqual(all.map((template) => template.id), [...templates.ORDER], 'templates are loaded in the order of ORDER');
      assert.equal(new Set(templates.ORDER).size, templates.ORDER.length);
      // WP44: the two films in the HUD style and the Suno pack follow the older music videos, the dubbing stays last
      assert.deepEqual(templates.ORDER.slice(templates.ORDER.indexOf('music-video')), ['music-video', 'music-video-stills', 'music-video-hud', 'music-video-hud-elevenlabs', 'suno-song-pack', 'dub-clip']);

      // the new ones: shapes, cheap defaults, usable for participants (no Higgsfield, no credits)
      assert.deepEqual(types('image-to-video'), ['input.image', 'input.prompt', 'video.seedance', 'output.result']);
      assert.deepEqual(types('text-on-video'), ['input.video', 'input.text', 'image.text_render', 'video.overlay_image', 'output.result']);
      // WP33b: the cutout of a video over another video
      assert.deepEqual(types('video-cutout-overlay'), ['input.video', 'fal.video_segment', 'input.video', 'video.overlay_video', 'output.result']);
      {
        const cutout = byId['video-cutout-overlay'];
        assert.deepEqual([...cutout.requires].sort(), ['fal', 'ffmpeg'], 'requires: fal.ai for the segmentation, ffmpeg for the overlay');
        assert.equal(cutout.graph.nodes.find((node) => node.type === 'fal.video_segment').params.output, 'cutout', 'the segmentation makes the WebM with alpha');
        const link = (to, port) => cutout.graph.edges.find((edge) => edge.to.node === to && edge.to.port === port);
        assert.equal(cutout.graph.nodes.find((node) => node.id === link('n4', 'layer').from.node).type, 'fal.video_segment', 'the cutout is the layer');
        assert.equal(cutout.graph.nodes.find((node) => node.id === link('n4', 'background').from.node).type, 'input.video', 'the second video is the background');
        const costText = (text) => assert.match(text, /0\.005 USD/, 'the description names the price of the segmentation');
        costText(cutout.description);
        assert.match(cutout.description, /Safari/, 'the description names the Safari limit');
        for (const lang of ['de', 'es']) {
          costText(cutout.i18n[lang].description);
          assert.match(cutout.i18n[lang].description, /Safari/, `${lang}: the Safari limit is named`);
        }
      }
      assert.deepEqual(types('storyboard-clips'), ['input.text', 'llm.chat', 'text.split', 'video.seedance', 'video.concat', 'output.result']);
      assert.deepEqual(types('image-formats'), ['input.image', 'image.resize', 'image.resize', 'image.resize', 'output.result']);
      assert.deepEqual(types('video-to-post'), ['input.video', 'llm.video_describer', 'input.text', 'text.template', 'llm.chat', 'output.result']);
      assert.deepEqual(types('photo-slideshow'), ['input.media_list', 'image.to_video', 'video.concat', 'output.result']);
      assert.deepEqual(types('photo-to-3d'), ['input.image', 'fal.remove_background', 'fal.image_to_3d', 'output.result']);
      assert.equal(byId['photo-to-3d'].graph.nodes.find((node) => node.type === 'fal.image_to_3d').params.model, 'tripo_h31', 'Tripo with a texture');
      assert.equal(byId['photo-to-3d'].graph.nodes.find((node) => node.type === 'fal.image_to_3d').params.texture, true);
      // the note sits below the card of the background removal even when that card shows a result image (about 480 px high), so the text stays readable
      const photoNote = byId['photo-to-3d'].graph.notes[0];
      const cutOut = byId['photo-to-3d'].graph.nodes.find((node) => node.type === 'fal.remove_background');
      assert.ok(photoNote.y >= cutOut.y + 480, `the note (y ${photoNote.y}) is under the card with its result (y ${cutOut.y})`);
      assert.deepEqual(templates.loadTemplates().find((item) => item.id === 'photo-to-3d').requires, ['fal']);
      assert.equal(templates.listTemplates({ lang: 'de', checks: Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true])) }).find((item) => item.id === 'photo-to-3d').name, 'Foto zu 3D-Modell');
      assert.equal(templates.resolveTemplate('photo-to-3d', { lang: 'es' }).name, 'Foto a modelo 3D');
      for (const id of ['image-to-video', 'storyboard-clips']) {
        for (const node of byId[id].graph.nodes.filter((item) => item.type === 'video.seedance')) {
          assert.ok(node.params.duration <= 4 && node.params.resolution === '480p', `${id}: a first run is short and small`);
        }
      }
      assert.ok(byId['storyboard-clips'].graph.nodes.find((node) => node.type === 'text.split').params.max <= 3, 'few shots by default');
      assert.deepEqual(
        byId['image-formats'].graph.nodes.filter((node) => node.type === 'image.resize').map((node) => `${node.params.width}x${node.params.height}`),
        ['1920x1080', '1080x1920', '1080x1080']
      );
      const noRestricted = all.filter((template) => !templates.usesRestrictedNodes(template.graph)).map((template) => template.id);
      assert.deepEqual(noRestricted.sort(), FOR_PARTICIPANTS);
      assert.ok(FOR_PARTICIPANTS.length - 7 >= 4, 'at least four of the new templates are for participants');
      assert.ok(FREE.length >= 2 && FREE.every((id) => FOR_PARTICIPANTS.includes(id)), 'at least two are free and local');
      assert.ok(templates.usesRestrictedNodes(byId['dub-clip'].graph), 'Higgsfield nodes are restricted');
      assert.ok(templates.usesRestrictedNodes(templates.resolveTemplate('dub-clip')), 'a document works as well as a graph');
      assert.equal(templates.usesRestrictedNodes({ nodes: [] }), false);
      // motion-title also serves as the lower third
      assert.match(byId['motion-title'].description, /lower third/i);
      assert.match(byId['motion-title'].graph.nodes[0].params.text, /Head of Marketing/);

      // the participant filter of the list; internal people (no filter) get everything
      const allOn = Object.fromEntries(templates.REQUIREMENTS.map((key) => [key, () => true]));
      assert.deepEqual(templates.listTemplates({ checks: allOn }).map((item) => item.id), [...templates.ORDER]);
      assert.deepEqual(templates.listTemplates({ checks: allOn, hideRestricted: true }).map((item) => item.id), FOR_PARTICIPANTS.slice().sort((a, b) => templates.ORDER.indexOf(a) - templates.ORDER.indexOf(b)));

      // the summary carries what the gallery needs
      const summary = Object.fromEntries(templates.listTemplates({ lang: 'de', checks: allOn }).map((item) => [item.id, item]));
      assert.deepEqual(summary['image-to-video'].nodeTypes, ['input.image', 'input.prompt', 'video.seedance', 'output.result']);
      assert.equal(summary['image-to-video'].nodeCount, 4);
      assert.deepEqual(summary['image-to-video'].flow, [[{ type: 'input.image', count: 1 }, { type: 'input.prompt', count: 1 }], [{ type: 'video.seedance', count: 1 }], [{ type: 'output.result', count: 1 }]]);
      assert.deepEqual(summary['dub-clip'].flow, [[{ type: 'input.video', count: 1 }], [{ type: 'hf.dubbing', count: 3 }], [{ type: 'output.result', count: 1 }]], 'equal types of one step are counted');
      assert.equal(summary['storyboard-clips'].batch, false, 'one idea goes in, the three shots are made inside: no Batch mark');
      assert.equal(summary['photo-slideshow'].batch, true);
      assert.equal(summary['image-formats'].batch, false);
      // the inputs stand together in the first step: "what you give -> what happens -> result"
      assert.deepEqual(summary['text-on-video'].flow[0].map((entry) => entry.type).sort(), ['input.text', 'input.video']);
      for (const id of EXPECTED) {
        const later = summary[id].flow.slice(1).flat().map((entry) => entry.type);
        assert.ok(!later.some((type) => type.startsWith('input.')), `${id}: every input stands in the first step`);
      }
      // the limit of the Concatenate node is named where the photos are uploaded
      const toolsLib = require('../lib/tools');
      for (const lang of ['en', 'de', 'es']) {
        const strings = templates.loadTemplates().find((item) => item.id === 'photo-slideshow').i18n[lang] || {};
        const texts = lang === 'en' ? [byId['photo-slideshow'].app.description, byId['photo-slideshow'].app.inputs[0].label] : [strings['app.description'], strings['app.input.n1.assets']];
        for (const text of texts) assert.match(text, new RegExp(`\\b${toolsLib.MAX_CONCAT_ASSETS}\\b`), `photo-slideshow ${lang}: the limit of ${toolsLib.MAX_CONCAT_ASSETS} photos is named`);
      }

      // cost: computed from the nodes, local = free, unknown is marked, never invented
      for (const id of EXPECTED) {
        const cost = summary[id].cost;
        // photo-to-3d is the exception: both of its nodes (background removal, image to 3D) have a price table; so has the segmentation
        // of video-cutout-overlay (an upper bound from max_seconds: 10 s at 30 frames = 19 blocks of 16 frames at 0.005 USD)
        // replace-people-in-video: an upload has no length, so the plan shows the upper bound of Kling O3 (15 s and the slack of 0.05 s at 0.14 USD a second)
        // the three explainer videos have one node with a price known beforehand: the background music (120 s at 0.20 USD a minute), so the
        // gallery says "from 0.40 USD"; everything else in them depends on the run (the script, the number of scenes)
        const explainerVideo = ['explainer-video', 'explainer-video-presenter', 'explainer-video-topic', 'typography-video', 'typography-video-text', 'motion-video-storyboard'].includes(id);
        assert.equal(cost.kind, FREE.includes(id) ? 'free' : id === 'photo-to-3d' || id === 'video-cutout-overlay' || id === 'replace-people-in-video' ? 'estimate' : explainerVideo ? 'partial' : 'unknown', `${id}: the shipped nodes have no price table`);
        // the typography videos are 90 s long, so is their music (90 s at 0.20 USD a minute); the motion video with storyboard is 45 s (0.15)
        if (explainerVideo) assert.equal(cost.usd, id.startsWith('typography-') ? 0.3 : id === 'motion-video-storyboard' ? 0.15 : 0.4, `${id}: only the music is known beforehand`);
        assert.equal(cost.paidNodes > 0, !FREE.includes(id));
        assert.deepEqual(cost.providers.every((key) => templates.PAID_PROVIDERS.includes(key)), true);
        if (FREE.includes(id)) assert.deepEqual(cost.providers, [], `${id}: nothing is billed`);
      }
      // photo to 3D: background removal (Bria, $0.018) + Tripo H3.1 with the standard texture ($0.30), one number in the gallery
      assert.deepEqual(summary['photo-to-3d'].cost, { kind: 'estimate', usd: 0.318, credits: 0, paidNodes: 2, providers: ['fal'] });
      assert.deepEqual(summary['video-cutout-overlay'].cost, { kind: 'estimate', usd: 0.095, credits: 0, paidNodes: 1, providers: ['fal'] });
      assert.deepEqual(summary['photo-to-3d'].flow.map((step) => step.map((entry) => entry.type)), [['input.image'], ['fal.remove_background'], ['fal.image_to_3d'], ['output.result']]);
      assert.deepEqual(summary['image-to-ad'].cost.providers, ['openrouter', 'elevenlabs']);
      assert.deepEqual(summary['dub-clip'].cost.providers, ['higgsfield']);
      // music: the length comes through a connection (the video, the song text), so the price is unknown, never 0
      assert.deepEqual(summary['video-with-music'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['elevenlabs'] });
      assert.deepEqual(summary['song-from-idea'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['elevenlabs'] });
      // the music video: the length of an uploaded song is unknown before the run, the number of scenes comes from the plan, the models
      // set the prices: six paid steps, none with a figure (the description names the order of magnitude)
      assert.deepEqual(summary['music-video'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 6, providers: ['openrouter', 'elevenlabs', 'fal'] });
      assert.deepEqual(summary['music-video'].flow.map((step) => step.map((entry) => `${entry.type}*${entry.count}`)), [
        ['input.audio*1', 'input.image*1'], ['audio.beats*1', 'audio.lyrics_timing*1'], ['music_video.plan*1'], ['text.template*2'], ['image.edit*2'],
        ['fal.h3_video*1', 'fal.h3_lipsync*1'], ['music_video.edit*1'], ['output.result*1']
      ]);
      assert.equal(summary['music-video'].batch, false, 'one song in, the lists are made inside: no Batch mark');
      // the variant with moving images: the story clips are the free zoom of this computer, so one paid step less; the depth maps of the
      // parallax switch (off by default, then free) count as a paid step of the gallery
      assert.deepEqual(summary['music-video-stills'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 6, providers: ['openrouter', 'elevenlabs', 'fal'] });
      assert.deepEqual(summary['music-video-stills'].flow.map((step) => step.map((entry) => `${entry.type}*${entry.count}`)), [
        ['input.audio*1', 'input.image*1'], ['audio.beats*1', 'audio.lyrics_timing*1'], ['music_video.plan*1'], ['text.template*2'], ['image.edit*2'],
        ['fal.depth_map*1', 'fal.h3_lipsync*1'], ['image.to_video*1'], ['music_video.edit*1'], ['output.result*1']
      ]);
      assert.equal(summary['music-video-stills'].batch, false);
      // WP44: the same for the films in the HUD style - the length of the song and the number of units come from the plan, so no figure (the descriptions
      // name the order of magnitude): the times, the planner, the sheet, three kinds of pictures, the lip sync, the clips and the depth maps are the nine
      // paid steps of the first; the music is the tenth of the second (its song text is free of credits). The Suno pack is one answer of a language model
      assert.deepEqual(summary['music-video-hud'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 9, providers: ['openrouter', 'elevenlabs', 'fal'] });
      assert.deepEqual(summary['music-video-hud-elevenlabs'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 10, providers: ['openrouter', 'elevenlabs', 'fal'] });
      assert.deepEqual(summary['suno-song-pack'].cost, { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['openrouter'] });
      const flowOf = (id) => summary[id].flow.map((step) => step.map((entry) => `${entry.type}*${entry.count}`));
      assert.deepEqual(flowOf('music-video-hud'), [
        ['input.audio*1'], ['audio.beats*1', 'audio.lyrics_timing*1'], ['music_video.hud_plan*1'], ['image.generate*1', 'text.template*3', 'output.result*1'], ['image.edit*3', 'output.result*1'],
        ['fal.h3_lipsync*1', 'fal.h3_video*1', 'fal.depth_map*1', 'output.result*3'], ['image.to_video*1'], ['music_video.edit*1'], ['music_video.hud_render*1'], ['output.result*2']
      ], 'the reading order of the film');
      assert.deepEqual(flowOf('music-video-hud-elevenlabs'), [
        ['input.prompt*1', 'input.text*1'], ['text.template*1'], ['audio.music_plan*1'], ['audio.music*1'], ['output.result*1', 'audio.beats*1', 'audio.lyrics_timing*1'], ['music_video.hud_plan*1'],
        ['image.generate*1', 'text.template*3', 'output.result*1'], ['image.edit*3', 'output.result*1'], ['fal.h3_lipsync*1', 'fal.h3_video*1', 'fal.depth_map*1', 'output.result*3'],
        ['image.to_video*1'], ['music_video.edit*1'], ['music_video.hud_render*1'], ['output.result*2']
      ], 'the same film behind the song');
      assert.deepEqual(flowOf('suno-song-pack'), [['input.prompt*1', 'input.text*1'], ['text.template*1'], ['llm.chat*1'], ['output.result*1']]);
      assert.equal(summary['music-video-hud'].batch, false);
      assert.equal(summary['music-video-hud-elevenlabs'].batch, false);
      assert.equal(summary['suno-song-pack'].batch, false);

      const priced = createRegistry();
      nodesBasic.registerAll(priced);
      const paid = (type, estimate, unit = 'usd') =>
        priced.register({
          type,
          category: 'utility',
          label: type,
          inputs: [{ id: 'text', type: 'text' }],
          outputs: [{ id: 'text', type: 'text' }],
          params: [{ id: 'size', kind: 'integer', default: 2 }],
          paid: true,
          cost: { unit, estimate },
          execute: async () => ({ variants: [{ text: textValue('x') }] })
        });
      paid('test.priced', (params) => ({ usd: 0.1 * params.size }));
      paid('test.credits', () => ({ credits: 12 }), 'credits');
      paid('test.vague', null);
      const chain = (...nodeTypes) => ({
        id: 'cost-demo',
        requires: ['openrouter', 'ffmpeg', 'fal'],
        graph: {
          nodes: [{ id: 'n0', type: 'input.text', params: { text: 'hi' }, x: 0, y: 0 }, ...nodeTypes.map((type, index) => ({ id: `n${index + 1}`, type, params: {}, x: 0, y: 0 }))],
          edges: nodeTypes.map((_type, index) => ({ id: `e${index}`, from: { node: `n${index}`, port: index ? 'text' : 'text' }, to: { node: `n${index + 1}`, port: 'text' } }))
        }
      });
      assert.deepEqual(templates.costSummary(chain('text.split'), { registry: priced }), { kind: 'free', usd: 0, credits: 0, paidNodes: 0, providers: [] }, 'a local chain is free');
      assert.deepEqual(templates.costSummary(chain('test.priced'), { registry: priced }), { kind: 'estimate', usd: 0.2, credits: 0, paidNodes: 1, providers: ['openrouter', 'fal'] });
      assert.deepEqual(templates.costSummary(chain('test.priced', 'test.priced'), { registry: priced }).usd, 0.4, 'the estimates add up');
      assert.deepEqual(templates.costSummary(chain('test.credits'), { registry: priced }), { kind: 'estimate', usd: 0, credits: 12, paidNodes: 1, providers: ['openrouter', 'fal'] });
      const partial = templates.costSummary(chain('test.priced', 'test.vague'), { registry: priced });
      assert.equal(partial.kind, 'partial');
      assert.equal(partial.usd, 0.2, 'what is known is the lower bound');
      assert.equal(templates.costSummary(chain('test.vague'), { registry: priced }).kind, 'unknown');
      assert.equal(templates.costSummary(chain('test.vague'), { registry: priced }).usd, 0);

      // a split of fixed size: one idea in, the list is made inside. Every paid node behind it runs once per part, so
      // the price is multiplied (no Batch mark); a list INPUT counts one entry ("per row")
      const splitGraph = (source, max) => ({
        id: 'split-demo',
        requires: ['openrouter'],
        graph: {
          nodes: [
            { id: 'a', type: source, params: source === 'input.text' ? { text: 'x' } : { text: 'x\ny' }, x: 0, y: 0 },
            ...(source === 'input.text' ? [{ id: 's', type: 'text.split', params: { max }, x: 0, y: 0 }] : []),
            { id: 'p', type: 'test.priced', params: {}, x: 0, y: 0 }
          ],
          edges: source === 'input.text'
            ? [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 's', port: 'text' } }, { id: 'e2', from: { node: 's', port: 'items' }, to: { node: 'p', port: 'text' } }]
            : [{ id: 'e1', from: { node: 'a', port: 'items' }, to: { node: 'p', port: 'text' } }]
        }
      });
      assert.equal(templates.costSummary(splitGraph('input.text', 3), { registry: priced }).usd, 0.6, 'three shots are paid three times');
      assert.equal(templates.costSummary(splitGraph('input.text', 1), { registry: priced }).usd, 0.2);
      assert.equal(templates.costSummary(splitGraph('input.text_list'), { registry: priced }).usd, 0.2, 'a list input counts one entry');
      assert.equal(templates.costSummary(chain('test.priced'), { registry: priced }).usd, 0.2, 'no list: unchanged');

      // a list that another node makes (the plan of a music video): how often the nodes behind it run is not known before the run, so
      // they have no price (counted once it would read as a few cents)
      priced.register({
        type: 'test.lister',
        category: 'utility',
        label: 'test.lister',
        inputs: [{ id: 'text', type: 'text' }],
        outputs: [{ id: 'items', type: 'text[]' }],
        params: [],
        execute: async () => ({ variants: [] })
      });
      const listedGraph = (...ids) => ({
        id: 'lister-demo',
        requires: ['openrouter'],
        graph: {
          nodes: [
            { id: 'a', type: 'input.text', params: { text: 'x' }, x: 0, y: 0 },
            ...ids.map((id) => ({ id, type: id === 'l' ? 'test.lister' : 'test.priced', params: {}, x: 0, y: 0 }))
          ],
          edges: ['a', ...ids].slice(0, -1).map((from, index) => ({ id: `e${index}`, from: { node: from, port: from === 'l' ? 'items' : 'text' }, to: { node: ids[index], port: 'text' } }))
        }
      });
      assert.deepEqual(templates.costSummary(listedGraph('l', 'p'), { registry: priced }), { kind: 'unknown', usd: 0, credits: 0, paidNodes: 1, providers: ['openrouter'] }, 'behind a list from a node: no price');
      const beforeList = templates.costSummary(listedGraph('q', 'l', 'p'), { registry: priced });
      assert.deepEqual([beforeList.kind, beforeList.usd, beforeList.paidNodes], ['partial', 0.2, 2], 'what runs once before the list is still priced');
      assert.equal(templates.listTemplates({ lang: 'en' }).find((item) => item.id === 'storyboard-clips').batch, false);

      // the engine helper behind it: availability never hides a price
      const engineLib = require('../lib/nodes/engine');
      const gated = createRegistry();
      nodesBasic.registerAll(gated);
      gated.register({ ...priced.get('test.priced'), type: 'test.gated', available: () => 'KEY is not set' });
      assert.equal(engineLib.estimateGraph(chain('test.gated').graph, { registry: gated }).usd, 0.2);

      // reading order of a graph
      const flow = templates.flowOf({
        nodes: [{ id: 'a', type: 'input.text' }, { id: 'b', type: 'text.join' }, { id: 'c', type: 'output.result' }, { id: 'd', type: 'input.text' }, { id: 'x', type: 'input.image' }],
        edges: [
          { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'items' } },
          { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'c', port: 'inputs' } },
          { id: 'e3', from: { node: 'd', port: 'text' }, to: { node: 'c', port: 'inputs' } }
        ]
      });
      // inputs all stand in the first step, even when they feed a later node
      assert.deepEqual(flow.map((step) => step.map((entry) => `${entry.count}x${entry.type}`)), [['2xinput.text', '1xinput.image'], ['1xtext.join'], ['1xoutput.result']]);
      // another node without a predecessor still moves up to just before its first consumer
      const lone = templates.flowOf({
        nodes: [{ id: 'a', type: 'input.text' }, { id: 'b', type: 'text.join' }, { id: 'c', type: 'text.join' }, { id: 'k', type: 'util.pick' }],
        edges: [
          { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'items' } },
          { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'c', port: 'items' } },
          { id: 'e3', from: { node: 'k', port: 'out' }, to: { node: 'c', port: 'items' } }
        ]
      });
      assert.deepEqual(lone.map((step) => step.map((entry) => entry.type)), [['input.text'], ['text.join', 'util.pick'], ['text.join']]);
    }

    /* ----- creation through the real routes: every template becomes a workflow ----- */
    {
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      const bus = createEventBus();
      const engine = createEngine({ store: wfStore, registry: nodeRegistry.registry, events: bus, getConfig: () => ({ imageModel: 'x' }) });
      registerNodeRoutes(app, { engine, store: wfStore, events: bus });
      server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = server.address().port;

      const listed = await get(port, 'GET', '/api/workflow-templates?lang=de');
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json.templates.map((item) => item.id).sort(), EXPECTED);
      assert.ok(listed.json.templates.every((item) => item.name && item.description && Array.isArray(item.requires)));
      assert.ok(listed.json.templates.every((item) => Array.isArray(item.nodeTypes) && Array.isArray(item.flow) && item.cost && item.cost.kind), 'node types, flow and cost travel with the list');

      // one template as a localized document (what the editor inserts into an open workflow)
      const one = await get(port, 'GET', '/api/workflow-templates/photo-slideshow?lang=de');
      assert.equal(one.status, 200);
      assert.equal(one.json.document.name, 'Fotoshow (lokal)');
      assert.equal(one.json.document.graph.nodes.length, 4);
      assert.equal(one.json.document.graph.nodes[0].title, 'Fotos');
      assert.ok(one.json.document.app && one.json.document.app.enabled, 'the document keeps its app section');
      assert.equal(one.json.document.i18n, undefined);
      assert.equal((await get(port, 'GET', '/api/workflow-templates/photo-slideshow?lang=xx')).json.document.name, 'Photo slideshow (local)');
      assert.equal((await get(port, 'GET', '/api/workflow-templates/nope')).status, 404);
      assert.equal((await get(port, 'GET', '/api/workflow-templates/..%2F..%2Fpackage')).status, 404);

      for (const id of EXPECTED) {
        const created = await get(port, 'POST', '/api/workflows', { templateId: id, lang: 'de' });
        assert.equal(created.status, 201, `${id}: ${JSON.stringify(created.json)}`);
        createdWorkflows.push(created.json.workflow.id);
        createdSessions.push(created.json.workflow.sessionId);
        const wf = created.json.workflow;
        assert.equal(wf.name, templates.resolveTemplate(id, { lang: 'de' }).name);
        assert.equal(wf.app.enabled, true);
        assert.deepEqual(markedIn(wf.app), markedIn(byId[id].app), `${id}: the marked outputs of the template are the ones of the new workflow`);
        assert.equal(wf.graph.nodes.length, byId[id].graph.nodes.length);
        // media inputs come without an asset; the copy is a fresh workflow with its own backing session
        assert.equal(wf.rev, 1);
        assert.equal((await store.readSession(wf.sessionId)).kind, 'workflow');
        const plan = await get(port, 'POST', `/api/workflows/${wf.id}/runs/plan`, { mode: 'all' });
        assert.equal(plan.status, 200, `${id} plan: ${JSON.stringify(plan.json)}`);
        assert.equal(Object.keys(plan.json.nodes).length, wf.graph.nodes.length, 'the plan covers every node');
      }
      assert.equal((await get(port, 'POST', '/api/workflows', { templateId: 'nope' })).status, 404);
      const named = await get(port, 'POST', '/api/workflows', { templateId: 'hero-variants', name: 'My hero' });
      createdWorkflows.push(named.json.workflow.id);
      createdSessions.push(named.json.workflow.sessionId);
      assert.equal(named.json.workflow.name, 'My hero', 'an explicit name wins over the template name');
    }

    /* ----- batch: a text list is mapped through the series-shots graph ----- */
    {
      // fake executors on the real definitions (same ports and params, no provider)
      const registry = createRegistry();
      nodesBasic.registerAll(registry);
      const seen = { edit: [], video: [], concat: [] };
      const fakeImage = (name) => ({ type: 'image', sessionId: 'fake-session', assetId: `img-${name}`, file: `${name}.png`, url: `/assets/fake-session/${name}.png` });
      const fakeVideo = (name) => ({ type: 'video', sessionId: 'fake-session', assetId: `vid-${name}`, file: `${name}.mp4`, url: `/assets/fake-session/${name}.mp4` });
      const fake = (type, execute) => {
        const def = nodeRegistry.get(type);
        registry.register({ ...def, available: () => true, validate: undefined, cost: undefined, execute });
      };
      registry.unregister('input.image');
      fake('input.image', async () => ({ variants: [{ image: fakeImage('ref') }] }));
      fake('image.edit', async (ctx, inputs) => {
        seen.edit.push(inputs.prompt.value);
        return { variants: [{ image: fakeImage(`edit${ctx.itemIndex}`) }] };
      });
      fake('video.seedance', async (ctx, inputs) => {
        seen.video.push(inputs.first_frame.assetId);
        return { variants: [{ video: fakeVideo(`clip${ctx.itemIndex}`) }] };
      });
      fake('video.concat', async (_ctx, inputs) => {
        const clips = inputs.clips.type === 'list' ? inputs.clips.items : [inputs.clips];
        seen.concat.push(clips.map((clip) => clip.assetId));
        return { variants: [{ video: fakeVideo('series') }] };
      });

      const bus = createEventBus();
      const localStore = createWorkflowsStore({ dir: tmpDir, registry, events: bus });
      const engine = createEngine({ store: localStore, registry, events: bus, getConfig: () => ({ imageModel: 'x' }), limits: { jobPollMs: 20 } });
      const doc = templates.resolveTemplate('series-shots', { lang: 'en' });
      // the image input needs no upload for the fake executor, but validation wants a resolvable asset param
      const created = await localStore.createWorkflow({ document: doc });
      createdWorkflows.push(created.workflow.id);
      createdSessions.push(created.workflow.sessionId);
      const id = created.workflow.id;

      const runId = await engine.start(id, { mode: 'all', user: 'tester' });
      const record = await engine.whenFinished(id, runId);
      assert.equal(record.status, 'completed', JSON.stringify(record.nodes));
      assert.equal(seen.edit.length, 3, 'one image edit per scene line');
      assert.deepEqual(seen.edit, [
        'The character walks through a sunlit market',
        'The character sits at a cafe window while it rains',
        'The character looks over the city from a rooftop at dusk'
      ]);
      assert.equal(seen.video.length, 3, 'one clip per still');
      assert.equal(seen.concat.length, 1, 'the clips are joined once');
      assert.equal(seen.concat[0].length, 3, 'concat receives all three clips');

      // overrides of the Design App: two scenes instead of three
      seen.edit.length = 0;
      seen.video.length = 0;
      seen.concat.length = 0;
      const second = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n2: { text: 'one\ntwo' } } });
      const secondRecord = await engine.whenFinished(id, second);
      assert.equal(secondRecord.status, 'completed');
      assert.deepEqual(seen.edit, ['one', 'two']);
      assert.equal(seen.concat[0].length, 2);
      const saved = await localStore.readWorkflow(id);
      assert.equal(saved.graph.nodes.find((node) => node.id === 'n2').params.text.split('\n').length, 3, 'overrides never change the saved graph');
      const results = await localStore.readResults(id);
      const outVariant = results.nodes.n6.history[0].variants[0];
      assert.equal(outVariant.result.type === 'video' || outVariant.result.type === 'list', true);

      // a listed input: app override of one item runs the map once
      seen.edit.length = 0;
      const third = await engine.start(id, { mode: 'all', user: 'tester', overrides: { n2: { text: 'solo' } } });
      await engine.whenFinished(id, third);
      assert.deepEqual(seen.edit, ['solo']);
      void textValue;
      void listValue;
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const workflowId of createdWorkflows) await wfStore.deleteWorkflow(workflowId).catch(() => {});
    for (const sessionId of createdSessions) await store.deleteSession(sessionId).catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  console.log('test-nodes-templates.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
