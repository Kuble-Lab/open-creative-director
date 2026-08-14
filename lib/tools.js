'use strict';

const fsp = require('fs/promises');
const path = require('path');

const store = require('./store');
const or = require('./openrouter');
const gts = require('./gts');
const brandings = require('./brandings');
const cast = require('./cast');
const discovery = require('./discovery');
const rendernode = require('./rendernode');
const costs = require('./costs');
const publicrefs = require('./publicrefs');
const elevenlabs = require('./elevenlabs');
const higgsfield = require('./higgsfield');

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const VIDEO_RESOLUTIONS = ['480p', '720p'];
const MAX_RENDER_ASSETS = 10;
const RENDER_FORMATS = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };
const MAX_RENDER_ASSET_BYTES = 24 * 1024 * 1024;
const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';
const HIGGSFIELD_MODEL_TEXT_LIMIT = 8000;
const HIGGSFIELD_JOB_TIMEOUT_MS = 10 * 60 * 1000;

const BRANDING_PATCH_PROPERTIES = {
  name: { type: 'string' },
  description: { type: 'string' },
  colors: {
    type: 'array',
    maxItems: 40,
    items: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        name: { type: 'string' },
        hex: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        usage: { type: 'string' }
      },
      required: ['hex'],
      additionalProperties: false
    }
  },
  typography: {
    type: 'array',
    maxItems: 40,
    items: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        family: { type: 'string' },
        weights: { type: 'string' },
        source: { type: 'string', enum: ['upload', 'google', 'system'] },
        file: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        usage: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  logos: {
    type: 'array',
    maxItems: 40,
    items: {
      type: 'object',
      properties: {
        variant: { type: 'string' },
        file: { type: 'string' },
        usage: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  imagery: {
    type: 'object',
    properties: {
      style: { type: 'string' },
      references: { type: 'array', items: { type: 'string' } }
    },
    additionalProperties: false
  },
  voice: {
    type: 'object',
    properties: {
      tone: { type: 'string' },
      language: { type: 'string' },
      dos: { type: 'string' },
      donts: { type: 'string' }
    },
    additionalProperties: false
  },
  motion: {
    type: 'object',
    properties: {
      outro: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      notes: { type: 'string' }
    },
    additionalProperties: false
  },
  sound: {
    type: 'array',
    maxItems: 40,
    items: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        file: { type: 'string' },
        usage: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  formats: {
    type: 'array',
    maxItems: 40,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        aspect_ratio: { type: 'string' },
        notes: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  guidelines: { type: 'string', maxLength: 8000 }
};

const BASE_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate a new still image with the image model. Use it for characters, products, environments, style references, storyboard frames and video first frames.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Full image prompt. MUST be written in English for best model performance, even when the conversation with the user is in another language. Be specific about subject, composition, lighting, lens, mood and background.'
          },
          aspect_ratio: {
            type: 'string',
            enum: IMAGE_RATIOS,
            description: 'Aspect ratio of the image. Match the aspect ratio of the planned final video.'
          }
        },
        required: ['prompt', 'aspect_ratio'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description:
        'Create a new image from one or more existing session assets used as visual references (edit, variation, combination, style transfer, character or product consistency).',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Edit instruction / target description. MUST be written in English. State clearly what to keep from the references and what to change.'
          },
          reference_asset_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Asset IDs of this session to use as visual references, e.g. ["img-002","upload-001"]. Only image or upload assets are allowed.'
          },
          aspect_ratio: {
            type: 'string',
            enum: IMAGE_RATIOS,
            description: 'Aspect ratio of the resulting image. Omit to keep it close to the reference.'
          }
        },
        required: ['prompt', 'reference_asset_ids'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description:
        'Start an asynchronous video generation job. Image references preserve appearance. A video reference preserves BOTH appearance and voice; an audio reference preserves voice/sound only. For recurring characters, ALWAYS reuse the same master clip in every shot.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Cinematic motion prompt. MUST be written in English. Focus on movement, camera, timing, physics and the end state. When a first frame image is used, do not re-describe details already visible in it.'
          },
          mode: {
            type: 'string',
            enum: ['text_to_video', 'image_to_video'],
            description:
              'Use image_to_video whenever identity, product accuracy or an exact starting composition matters and a suitable image asset exists.'
          },
          first_frame_asset_id: {
            type: 'string',
            description:
              'Required for mode=image_to_video: asset ID of the image used as the first frame, e.g. "img-003".'
          },
          reference_asset_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 30,
            description:
              'Optional additional image asset IDs passed as visual references. Seedance 2.5 accepts up to 30 reference images for identity, props and style. For shots in a series, consistently pass the same references to preserve continuity.'
          },
          reference_video_asset_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description:
              'Optional MP4/WebM session assets published as video_url references. A video reference transfers BOTH the character appearance and voice. For recurring characters, ALWAYS pass the same short master clip.'
          },
          reference_audio_asset_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description:
              'Optional MP3/WAV/M4A/AAC session assets published as audio_url references. An audio reference transfers only voice/sound, not appearance.'
          },
          duration_seconds: {
            type: 'integer',
            minimum: 4,
            maximum: 30,
            description: 'Clip length in whole seconds. Supported range: 4-30 seconds.'
          },
          aspect_ratio: {
            type: 'string',
            enum: VIDEO_RATIOS,
            description:
              'Text-to-video only. Supported values: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9. NEVER set aspect_ratio for image-to-video: the first frame defines it.'
          },
          resolution: {
            type: 'string',
            enum: VIDEO_RESOLUTIONS,
            description: 'Output resolution. Supported values: 480p and 720p only. 1080p is not supported. Defaults to 720p.'
          }
        },
        required: ['prompt', 'mode'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_speech',
      description:
        'Generate an ElevenLabs MP3 speech asset. Use the audio as a voice master for casting or pass it to Seedance via reference_audio_asset_ids.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            maxLength: 2500,
            description: 'Text to speak, with a maximum of 2500 characters.'
          },
          voice_id: {
            type: 'string',
            default: DEFAULT_ELEVENLABS_VOICE_ID,
            description: `ElevenLabs voice ID. Defaults to ${DEFAULT_ELEVENLABS_VOICE_ID}.`
          },
          model_id: {
            type: 'string',
            default: DEFAULT_ELEVENLABS_MODEL_ID,
            description: `ElevenLabs model ID. Defaults to ${DEFAULT_ELEVENLABS_MODEL_ID}.`
          }
        },
        required: ['text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_voices',
      description: 'List the available ElevenLabs voices with their names, voice IDs and labels.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'import_gts_asset',
      description:
        'Import a file attached to a GTS knowledge brain (e.g. logos, brand images, fonts from the design system) into this session as an asset. Use list from the attached-context asset inventory. Raster images (png/jpg/webp) work directly in edit_image and generate_video. SVGs are additionally auto-rasterized to a PNG asset on import - use the PNG asset id (given in the import confirmation) for edit_image/generate_video, and the SVG asset id only for render_motion_graphics.',
      parameters: {
        type: 'object',
        properties: {
          brain_id: {
            type: 'string',
            description: 'Full GTS brain ID from the attached knowledge context.'
          },
          filename: {
            type: 'string',
            description: 'Exact filename as listed in the attached-context asset inventory.'
          }
        },
        required: ['brain_id', 'filename'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_branding',
      description:
        'Create a reusable brand system. After creation, use update_branding to define its sections and add_branding_asset to preserve approved session assets.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the brand system.' },
          description: { type: 'string', description: 'Short purpose or brand description.' }
        },
        required: ['name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_branding',
      description:
        'Replace one or more complete top-level sections of an existing brand system. Include only confirmed sections; omitted sections stay unchanged.',
      parameters: {
        type: 'object',
        properties: {
          branding_id: { type: 'string' },
          patch: {
            type: 'object',
            properties: BRANDING_PATCH_PROPERTIES,
            additionalProperties: false
          }
        },
        required: ['branding_id', 'patch'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_branding_asset',
      description:
        'Copy an approved upload or generated session asset into a brand system and register it as a logo, imagery reference, outro, sound or font.',
      parameters: {
        type: 'object',
        properties: {
          branding_id: { type: 'string' },
          session_asset_id: { type: 'string' },
          target: { type: 'string', enum: ['logo', 'imagery', 'outro', 'sound', 'font'] },
          meta: {
            type: 'object',
            properties: {
              variant: { type: 'string' },
              usage: { type: 'string' },
              title: { type: 'string' }
            },
            additionalProperties: false
          }
        },
        required: ['branding_id', 'session_asset_id', 'target'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'import_branding_asset',
      description:
        'Import a file from a brand system into this session. Raster images are shown as hidden previews; SVG files are additionally rasterised to PNG for image and video tools.',
      parameters: {
        type: 'object',
        properties: {
          branding_id: { type: 'string' },
          filename: { type: 'string', description: 'Exact filename from the brand-system inventory.' }
        },
        required: ['branding_id', 'filename'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_cast_member',
      description:
        'Create a reusable cast member in the current project. Preserve approved character images and one voice master; a short speaking video is preferred because it anchors both appearance and voice.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 60 },
          soul: { type: 'string', maxLength: 2000, description: 'Character, personality and speaking style.' },
          image_asset_ids: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          voice_asset_id: { type: 'string', description: 'Optional MP4, MP3 or WAV session asset used as the voice master.' }
        },
        required: ['name', 'soul'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_cast_member',
      description:
        'Update a cast member in the current project by exact ID or unique name. Add approved images or replace the voice master.',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'string', description: 'Exact cast-member ID.' },
          name: { type: 'string', description: 'Unique current cast-member name, used when member_id is omitted.' },
          new_name: { type: 'string', maxLength: 60 },
          soul: { type: 'string', maxLength: 2000 },
          add_image_asset_ids: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          voice_asset_id: { type: 'string', description: 'MP4, MP3 or WAV session asset; replaces the current voice master.' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'import_cast_asset',
      description:
        'Import a cast image or voice master into the current session before generating a shot. Images are used in reference_asset_ids; MP4 voice masters in reference_video_asset_ids; audio voice masters in reference_audio_asset_ids.',
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: 'Exact cast-member ID or unique name.' },
          asset: { type: 'string', description: 'Either "voice" or "image:<1-based index or exact filename>".' }
        },
        required: ['member', 'asset'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a durable production learning for all future sessions. For PROJECT-specific rules use save_project_memory instead.',
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description:
              'Persist a durable production learning or user preference that should apply to ALL future sessions (e.g. recurring characters, brand rules, mistakes to avoid). Keep it to one short sentence.'
          }
        },
        required: ['note'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_project_memory',
      description:
        'Save a durable PROJECT rule or preference that applies to ALL chats in the current project, such as a series format, recurring-character rule or style decision. For learnings that apply across projects, continue to use save_memory.',
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            maxLength: 500,
            description: 'One durable project-specific rule or preference, in at most 500 characters.'
          }
        },
        required: ['note'],
        additionalProperties: false
      }
    }
  }
];

const RENDER_MOTION_GRAPHICS_DEFINITION = {
  type: 'function',
  function: {
    name: 'render_motion_graphics',
    description: [
      'Render deterministic HTML/GSAP motion graphics on a dedicated HyperFrames render node.',
      'Use this for motion graphics, title cards, animated infographics, logo animations and kinetic typography.',
      'Pass session assets (uploads, generated images, generated videos) via asset_ids and reference them in the HTML by their exact filename, e.g. <img src="upload-001.png">, <video src="vid-002.mp4" muted> - video layers are frame-extracted deterministically by the renderer. Use this to overlay animated text on an existing video or to build motion graphics around a logo.',
      'Do NOT use it for photorealistic footage; use generate_video for that.',
      'Choose the output format via the format parameter: landscape = 1920x1080 (16:9), portrait = 1080x1920 (9:16, e.g. Reels/Stories/TikTok), square = 1080x1080 (1:1). The composition dimensions MUST match the chosen format.',
      'The html argument MUST be a complete inline HTML document that follows this composition contract exactly:',
      '1. Load GSAP with <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>.',
      '2. Set body,html { margin:0; width:<W>px; height:<H>px; overflow:hidden; } where <W>x<H> are the dimensions of the chosen format; these dimensions must match data-width and data-height.',
      '3. Use this root element: <div id="main-composition" data-composition-id="main" data-width="<W>" data-height="<H>" data-start="0" data-duration="<SECONDS>">...</div>. The video duration comes from data-duration.',
      '4. Put an inline script AT THE END INSIDE the root div. It must synchronously create a PAUSED GSAP timeline with const tl = gsap.timeline({paused:true}); and register it with window.__timelines = window.__timelines || {}; window.__timelines[\'main\'] = tl;.',
      'Do not reference external composition files and do not use data-composition-src. Keep the complete composition inline. Images may use HTTPS URLs or CSS.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description: 'Complete inline HTML composition document following the full HyperFrames contract in this tool description.'
        },
        quality: {
          type: 'string',
          enum: ['draft', 'standard', 'high'],
          default: 'standard',
          description: 'Render quality. Defaults to standard.'
        },
        format: {
          type: 'string',
          enum: ['landscape', 'portrait', 'square'],
          default: 'landscape',
          description:
            'Output format: landscape 1920x1080 (16:9), portrait 1080x1920 (9:16 vertical), square 1080x1080 (1:1). The composition data-width/data-height must match. Defaults to landscape.'
        },
        label: {
          type: 'string',
          description: 'Short human-readable German description of the clip, for example "Titel-Animation Produktlaunch".'
        },
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_RENDER_ASSETS,
          description:
            'Optional session asset IDs to copy beside index.html, e.g. ["upload-001", "img-002", "vid-003"]. Reference each asset in the HTML by its exact filename including the extension.'
        }
      },
      required: ['html', 'label'],
      additionalProperties: false
    }
  }
};

const HIGGSFIELD_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'higgsfield_models',
      description:
        'Explore Higgsfield models before generating. Always use this first to verify the exact model ID, allowed aspect_ratios, model-specific parameters and accepted media roles. Pass goal for recommendations or model for exact details.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the generation should achieve and which inputs are available.' },
          type: { type: 'string', enum: ['image', 'video', 'audio', '3d'], description: 'Optional output-type filter.' },
          model: { type: 'string', description: 'Exact model ID to inspect.' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'higgsfield_generate_image',
      description:
        'Start one asynchronous Higgsfield image generation paid with Higgsfield credits. Explore the model first and verify aspect ratios, parameters and media roles. The result is stored as a session image asset.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Exact Higgsfield model ID from higgsfield_models.' },
          prompt: { type: 'string', description: 'Full generation prompt in English.' },
          aspect_ratio: { type: 'string' },
          resolution: { type: 'string' },
          reference_asset_ids: { type: 'array', maxItems: 12, items: { type: 'string' } }
        },
        required: ['model', 'prompt'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'higgsfield_generate_video',
      description:
        'Start one asynchronous Higgsfield video generation paid with Higgsfield credits. Check higgsfield_check_balance before expensive video work, mention the credit charge to the user, and explore the model first. The result is stored as a session video asset.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Exact Higgsfield model ID from higgsfield_models.' },
          prompt: { type: 'string', description: 'Full cinematic generation prompt in English.' },
          aspect_ratio: { type: 'string' },
          duration: { type: 'integer' },
          resolution: { type: 'string' },
          reference_asset_ids: { type: 'array', maxItems: 12, items: { type: 'string' } }
        },
        required: ['model', 'prompt'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'higgsfield_check_balance',
      description:
        'Check the current Higgsfield credit balance and plan. Use this before expensive video jobs and mention the available credits to the user for cost transparency.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  }
];

function toolDefinitions() {
  const definitions = BASE_TOOL_DEFINITIONS.slice();
  if (rendernode.enabled()) definitions.push(RENDER_MOTION_GRAPHICS_DEFINITION);
  if (higgsfield.status().connected) definitions.push(...HIGGSFIELD_TOOL_DEFINITIONS);
  return definitions;
}

function extFromMediaType(mediaType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return map[String(mediaType || '').toLowerCase()] || '.png';
}

function shorten(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function recordToolCost(entry) {
  try {
    await costs.recordCost(entry);
  } catch (err) {
    console.warn('[costs] Tool-Kosten konnten nicht erfasst werden:', err.message);
  }
}

const RASTER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// Die Bild-/Video-APIs akzeptieren nur Rasterformate; SVG & Co. muessen vorher klar abgewiesen werden.
async function requireRasterAsset(sessionId, id) {
  const entries = await store.readLedger(sessionId);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return; // assetDataUrl liefert gleich den sprechenden Fehler
  const ext = path.extname(entry.file).toLowerCase();
  if (!RASTER_EXTS.has(ext)) {
    throw new Error(
      `Asset ${id} (${ext}) ist kein Rasterbild - die Bild-/Video-API akzeptiert nur PNG, JPEG oder WebP. ` +
        'SVG-Importe aus dem GTS erhalten automatisch eine PNG-Variante (Asset-ID steht in der Import-Bestaetigung) - nutze diese. ' +
        'Fuer Vektor-Compositing nutze render_motion_graphics, das SVG direkt kann.'
    );
  }
}

async function referencesFromAssetIds(sessionId, ids) {
  const out = [];
  for (const id of ids || []) {
    await requireRasterAsset(sessionId, id);
    const url = await store.assetDataUrl(sessionId, id);
    out.push({ type: 'image_url', image_url: { url } });
  }
  return out;
}

async function runGenerateImage(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  ctx.emit({ type: 'tool_start', tool: 'generate_image', label: `Erzeuge Bild: ${shorten(prompt, 90)}` });

  const payload = { model: ctx.config.imageModel, prompt, n: 1 };
  if (args.aspect_ratio) payload.aspect_ratio = args.aspect_ratio;

  const result = await or.createImage(payload);
  return storeImageResult(ctx, result, prompt);
}

async function runEditImage(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  const refIds = Array.isArray(args.reference_asset_ids) ? args.reference_asset_ids : [];
  if (!prompt) throw new Error('prompt fehlt');
  if (refIds.length === 0) throw new Error('reference_asset_ids muss mindestens ein Asset enthalten');
  ctx.emit({
    type: 'tool_start',
    tool: 'edit_image',
    label: `Bearbeite Bild (${refIds.join(', ')}): ${shorten(prompt, 70)}`
  });

  const payload = {
    model: ctx.config.imageModel,
    prompt,
    n: 1,
    input_references: await referencesFromAssetIds(ctx.sessionId, refIds)
  };
  if (args.aspect_ratio) payload.aspect_ratio = args.aspect_ratio;

  const result = await or.createImage(payload);
  return storeImageResult(ctx, result, prompt);
}

function requireElevenLabsKey() {
  if (!elevenlabs.hasKey()) {
    throw new Error('Kein ELEVENLABS_API_KEY hinterlegt — unter ⚙️ Einstellungen setzen.');
  }
}

async function runGenerateSpeech(ctx, args) {
  requireElevenLabsKey();
  const text = String(args.text || '').trim();
  const characters = [...text];
  if (!text) throw new Error('text fehlt');
  if (characters.length > 2500) throw new Error('text darf maximal 2500 Zeichen lang sein');
  const voiceId = String(args.voice_id || DEFAULT_ELEVENLABS_VOICE_ID).trim();
  const modelId = String(args.model_id || DEFAULT_ELEVENLABS_MODEL_ID).trim();
  if (!voiceId) throw new Error('voice_id darf nicht leer sein');
  if (!modelId) throw new Error('model_id darf nicht leer sein');

  ctx.emit({
    type: 'tool_start',
    tool: 'generate_speech',
    label: `Erzeuge Sprache mit ElevenLabs: ${shorten(text, 80)}`
  });
  const buffer = await elevenlabs.tts({ text, voiceId, modelId });
  if (!buffer.length) throw new Error('ElevenLabs lieferte eine leere Audio-Datei.');
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'audio',
    buffer,
    ext: '.mp3',
    prompt: `ElevenLabs Sprache: ${shorten(text, 160)}`,
    cost: null
  });
  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'audio', prompt: asset.prompt, cost: null }
  });
  return {
    toolResult:
      `Sprache erzeugt: ${asset.id} (${characters.length} Zeichen). ` +
      `Nutze ${asset.id} als Voice-Master beim Casting oder in reference_audio_asset_ids fuer Seedance.`,
    inject: [],
    asset
  };
}

function voiceLabels(labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return '';
  const entries = Object.entries(labels)
    .filter(([key, value]) => key && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .map(([key, value]) => `${key}=${value}`);
  return entries.length ? ` (${entries.join(', ')})` : '';
}

async function runListVoices(ctx) {
  requireElevenLabsKey();
  ctx.emit({ type: 'tool_start', tool: 'list_voices', label: 'Lade ElevenLabs-Stimmen' });
  const voices = await elevenlabs.listVoices();
  const lines = voices.map((voice) => `- ${voice.name}: ${voice.voice_id}${voiceLabels(voice.labels)}`);
  return {
    toolResult: lines.length
      ? `Verfuegbare ElevenLabs-Stimmen (${lines.length}):\n${lines.join('\n')}`
      : 'ElevenLabs meldet keine verfuegbaren Stimmen.',
    inject: []
  };
}

// Shared image post-processing: save file, emit asset, inject preview for the brain.
async function storeImageResult(ctx, result, prompt) {
  const item = result?.data?.[0];
  if (!item?.b64_json) throw new Error('Antwort der Bild-API enthielt keine Bilddaten.');
  const cost = typeof result?.usage?.cost === 'number' ? result.usage.cost : null;
  const buffer = Buffer.from(item.b64_json, 'base64');
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'image',
    buffer,
    ext: extFromMediaType(item.media_type),
    prompt,
    cost
  });
  if (cost !== null) {
    await recordToolCost({
      ts: asset.createdAt,
      sessionId: ctx.sessionId,
      assetId: asset.id,
      type: 'image',
      model: ctx.config.imageModel,
      cost,
      user: ctx.user || 'lokal'
    });
  }

  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'image', prompt, cost: asset.cost }
  });

  const dataUrl = `data:${item.media_type || 'image/png'};base64,${item.b64_json}`;
  return {
    toolResult: `Bild erzeugt: ${asset.id} (Datei ${asset.file}). Das Bild wird dir direkt im Anschluss zur Pruefung gezeigt.`,
    inject: [
      {
        role: 'user',
        hidden: true,
        content: [
          { type: 'text', text: `[System] Automatische Vorschau von ${asset.id} zur Pruefung:` },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    asset
  };
}

function safeExtFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '.bin';
}

function rasterMimeForExt(ext, mimeType) {
  const expected = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  }[ext];
  if (!expected) return '';
  const listed = String(mimeType || '').toLowerCase();
  return listed === expected ? listed : expected;
}

async function storeImportedSessionAsset(ctx, { buffer, filename, prompt, sourceLabel, mimeType = '', kind = 'upload' }) {
  const ext = safeExtFromFilename(filename);
  const asset = await store.saveAsset(ctx.sessionId, {
    kind,
    buffer,
    ext,
    prompt,
    cost: null
  });

  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind, prompt, cost: null }
  });

  let toolResult = `${sourceLabel} importiert: ${filename} als ${asset.id} (Datei ${asset.file}).`;
  let previewMime = rasterMimeForExt(ext, mimeType);
  let previewBuffer = buffer;
  let previewId = asset.id;

  // SVGs koennen die Bild-/Video-APIs nicht verarbeiten - zusaetzlich als PNG rastern.
  if (ext === '.svg') {
    try {
      const { Resvg } = require('@resvg/resvg-js');
      const pngBuffer = new Resvg(buffer.toString('utf8'), {
        fitTo: { mode: 'width', value: 1024 }
      }).render().asPng();
      const pngAsset = await store.saveAsset(ctx.sessionId, {
        kind: 'upload',
        buffer: pngBuffer,
        ext: '.png',
        prompt: `${prompt} (PNG aus SVG)`,
        cost: null
      });
      ctx.emit({
        type: 'asset',
        asset: { id: pngAsset.id, url: pngAsset.url, kind: 'upload', prompt: pngAsset.prompt, cost: null }
      });
      toolResult =
        `${sourceLabel} importiert: ${filename} als ${asset.id} (SVG) und zusaetzlich als ${pngAsset.id} (PNG, 1024px gerastert). ` +
        `Nutze ${pngAsset.id} fuer edit_image und generate_video, ${asset.id} fuer render_motion_graphics.`;
      previewMime = 'image/png';
      previewBuffer = pngBuffer;
      previewId = pngAsset.id;
    } catch (err) {
      toolResult += ` Hinweis: PNG-Rasterung fehlgeschlagen (${err.message}) - das SVG ist nur fuer render_motion_graphics nutzbar, nicht fuer edit_image/generate_video.`;
    }
  }

  const inject = previewMime
    ? [
        {
          role: 'user',
          hidden: true,
          content: [
            { type: 'text', text: `[System] Automatische Vorschau des Imports ${previewId} zur Pruefung:` },
            { type: 'image_url', image_url: { url: `data:${previewMime};base64,${previewBuffer.toString('base64')}` } }
          ]
        }
      ]
    : [];

  return {
    toolResult,
    inject,
    asset
  };
}

async function runImportGtsAsset(ctx, args) {
  const brainId = String(args.brain_id || '').trim();
  const requestedFilename = String(args.filename || '').trim();
  if (!brainId) throw new Error('brain_id fehlt');
  if (!requestedFilename) throw new Error('filename fehlt');

  ctx.emit({
    type: 'tool_start',
    tool: 'import_gts_asset',
    label: `Importiere GTS-Datei: ${shorten(requestedFilename, 90)}`
  });

  const assets = await gts.listAssets(brainId);
  const filenameLower = requestedFilename.toLowerCase();
  const source = assets.find((asset) => asset.filename.toLowerCase() === filenameLower);
  if (!source) throw new Error(`Datei ${requestedFilename} ist nicht an Brain ${brainId} angehaengt.`);

  return storeImportedSessionAsset(ctx, {
    buffer: await gts.downloadAsset(source.url),
    filename: source.filename,
    prompt: `GTS-Import: ${source.filename} aus ${brainId}`,
    sourceLabel: 'GTS-Datei',
    mimeType: source.mimeType
  });
}

function requiredString(value, field) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`${field} fehlt`);
  return clean;
}

async function runCreateBranding(ctx, args) {
  const name = requiredString(args.name, 'name');
  const description = args.description === undefined ? '' : String(args.description);
  ctx.emit({ type: 'tool_start', tool: 'create_branding', label: `Erstelle Branding: ${shorten(name, 90)}` });
  const branding = await brandings.createBranding({ name, description });
  return {
    toolResult: `Branding erstellt: ${branding.name} (ID ${branding.id}). Nutze jetzt update_branding fuer die Inhalte und add_branding_asset fuer bestaetigte Assets.`,
    inject: []
  };
}

async function runUpdateBranding(ctx, args) {
  const brandingId = await brandings.resolveBrandingId(requiredString(args.branding_id, 'branding_id'));
  if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
    throw new Error('patch muss ein Objekt sein');
  }
  ctx.emit({ type: 'tool_start', tool: 'update_branding', label: `Aktualisiere Branding ${brandingId}` });
  const updated = await brandings.updateBranding(brandingId, args.patch);
  const fields = Object.keys(args.patch);
  return {
    toolResult: `Branding ${updated.name} (${updated.id}) aktualisiert. Gesetzt: ${fields.length ? fields.join(', ') : 'keine Felder'}.`,
    inject: []
  };
}

async function sessionAssetBuffer(sessionId, assetId) {
  if (!store.isValidId(assetId)) throw new Error(`Ungueltige Session-Asset-ID: ${assetId}`);
  const ledger = await store.readLedger(sessionId);
  const entry = ledger.find((item) => item.id === assetId);
  if (!entry) throw new Error(`Session-Asset nicht gefunden: ${assetId}`);
  if (entry.pending) throw new Error(`Session-Asset ${assetId} ist noch nicht fertig`);
  const storedFile = String(entry.file || '');
  if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
    throw new Error(`Session-Asset ${assetId} hat einen ungueltigen Dateinamen`);
  }
  try {
    return {
      entry,
      buffer: await fsp.readFile(path.join(store.sessionAssetDir(sessionId), storedFile))
    };
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Session-Asset ${assetId} konnte nicht gelesen werden: Datei fehlt`);
    throw err;
  }
}

function cleanMeta(meta) {
  const input = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  return {
    variant: typeof input.variant === 'string' ? input.variant.trim() : '',
    usage: typeof input.usage === 'string' ? input.usage.trim() : '',
    title: typeof input.title === 'string' ? input.title.trim() : ''
  };
}

async function runAddBrandingAsset(ctx, args) {
  const brandingId = await brandings.resolveBrandingId(requiredString(args.branding_id, 'branding_id'));
  const assetId = requiredString(args.session_asset_id, 'session_asset_id');
  const target = requiredString(args.target, 'target');
  if (!['logo', 'imagery', 'outro', 'sound', 'font'].includes(target)) {
    throw new Error('target muss logo, imagery, outro, sound oder font sein');
  }
  await brandings.readBranding(brandingId);
  const { entry, buffer } = await sessionAssetBuffer(ctx.sessionId, assetId);
  const meta = cleanMeta(args.meta);
  ctx.emit({
    type: 'tool_start',
    tool: 'add_branding_asset',
    label: `Sichere ${assetId} im Branding ${brandingId}`
  });
  const saved = await brandings.saveBrandingAsset(brandingId, { buffer, filename: entry.file });

  try {
    const branding = await brandings.readBranding(brandingId);
    let patch;
    if (target === 'logo') {
      patch = {
        logos: [...branding.logos, { variant: meta.variant || 'primary', file: saved.file, usage: meta.usage }]
      };
    } else if (target === 'imagery') {
      patch = {
        imagery: {
          ...branding.imagery,
          references: [...branding.imagery.references, saved.file]
        }
      };
    } else if (target === 'outro') {
      patch = { motion: { ...branding.motion, outro: saved.file } };
    } else if (target === 'sound') {
      patch = {
        sound: [...branding.sound, {
          title: meta.title || path.basename(saved.filename, path.extname(saved.filename)),
          file: saved.file,
          usage: meta.usage || 'background'
        }]
      };
    } else {
      patch = {
        typography: [...branding.typography, {
          role: meta.variant || 'brand',
          family: meta.title || path.basename(saved.filename, path.extname(saved.filename)),
          weights: '',
          source: 'upload',
          file: saved.file,
          usage: meta.usage
        }]
      };
    }
    await brandings.updateBranding(brandingId, patch);
  } catch (err) {
    await brandings.removeBrandingAsset(brandingId, saved.filename).catch(() => {});
    throw err;
  }

  return {
    toolResult: `Session-Asset ${assetId} als ${target} im Branding ${brandingId} gesichert: ${saved.filename}.`,
    inject: []
  };
}

const BRANDING_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

async function runImportBrandingAsset(ctx, args) {
  const brandingId = await brandings.resolveBrandingId(requiredString(args.branding_id, 'branding_id'));
  const filename = requiredString(args.filename, 'filename');
  ctx.emit({
    type: 'tool_start',
    tool: 'import_branding_asset',
    label: `Importiere Branding-Datei: ${shorten(filename, 90)}`
  });
  const buffer = await brandings.readBrandingAsset(brandingId, filename);
  return storeImportedSessionAsset(ctx, {
    buffer,
    filename,
    prompt: `Branding-Import: ${filename} aus ${brandingId}`,
    sourceLabel: 'Branding-Datei',
    mimeType: BRANDING_MIME_TYPES[path.extname(filename).toLowerCase()] || ''
  });
}

async function requireProjectFolder(ctx) {
  const session = await store.readSession(ctx.sessionId);
  const folder = typeof session.folder === 'string' ? session.folder.trim() : '';
  if (!folder) {
    throw new Error('Casting ist nur in einem Projekt verfuegbar. Verschiebe diesen Chat zuerst in ein Projekt.');
  }
  return folder;
}

async function castSourceAssets(sessionId, rawIds, field, allowedExtensions, maxItems) {
  if (rawIds === undefined || rawIds === null) return [];
  if (!Array.isArray(rawIds)) throw new Error(`${field} muss ein Array sein`);
  if (rawIds.length > maxItems) throw new Error(`${field} darf maximal ${maxItems} Assets enthalten`);
  const ledger = await store.readLedger(sessionId);
  return rawIds.map((rawId) => {
    const id = requiredString(rawId, field);
    const asset = ledger.find((entry) => entry.id === id);
    if (!asset) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (asset.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    const ext = path.extname(asset.file).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) hat fuer ${field} den falschen Dateityp.`);
    }
    return asset;
  });
}

async function castSourceAsset(sessionId, rawId, field, allowedExtensions) {
  if (rawId === undefined || rawId === null || rawId === '') return null;
  return (await castSourceAssets(sessionId, [rawId], field, allowedExtensions, 1))[0];
}

async function runCreateCastMember(ctx, args) {
  const folder = await requireProjectFolder(ctx);
  const name = requiredString(args.name, 'name');
  const soul = typeof args.soul === 'string' ? args.soul : '';
  const images = await castSourceAssets(ctx.sessionId, args.image_asset_ids, 'image_asset_ids', cast.IMAGE_EXTENSIONS, 6);
  const voice = await castSourceAsset(ctx.sessionId, args.voice_asset_id, 'voice_asset_id', cast.VOICE_EXTENSIONS);
  ctx.emit({ type: 'tool_start', tool: 'create_cast_member', label: `Erstelle Cast-Mitglied: ${shorten(name, 60)}` });

  const member = await cast.createMember(folder, { name, soul });
  try {
    for (const asset of images) {
      await cast.addMemberAsset(member.id, {
        kind: 'image',
        sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), asset.file),
        filename: asset.file
      });
    }
    if (voice) {
      await cast.addMemberAsset(member.id, {
        kind: 'voice',
        sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), voice.file),
        filename: voice.file
      });
    }
  } catch (err) {
    await cast.removeMember(member.id).catch(() => {});
    throw err;
  }
  const saved = await cast.readMember(member.id);
  return {
    toolResult: `Cast-Mitglied ${saved.name} erstellt (ID ${saved.id}, ${saved.images.length} Bild(er), Stimme ${saved.voice ? 'vorhanden' : 'noch offen'}).`,
    inject: []
  };
}

async function runUpdateCastMember(ctx, args) {
  const folder = await requireProjectFolder(ctx);
  const query = args.member_id || args.name;
  if (!query) throw new Error('member_id oder eindeutiger name fehlt');
  const memberId = await cast.resolveMemberId(folder, query);
  const current = await cast.readMember(memberId);
  const images = await castSourceAssets(ctx.sessionId, args.add_image_asset_ids, 'add_image_asset_ids', cast.IMAGE_EXTENSIONS, 6);
  if (current.images.length + images.length > cast.MAX_IMAGES) {
    throw new Error(`Pro Cast-Mitglied sind maximal ${cast.MAX_IMAGES} Bilder erlaubt`);
  }
  const voice = await castSourceAsset(ctx.sessionId, args.voice_asset_id, 'voice_asset_id', cast.VOICE_EXTENSIONS);
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(args, 'new_name')) patch.name = args.new_name;
  if (Object.prototype.hasOwnProperty.call(args, 'soul')) patch.soul = args.soul;
  if (!Object.keys(patch).length && !images.length && !voice) throw new Error('Keine Aenderung angegeben');
  ctx.emit({ type: 'tool_start', tool: 'update_cast_member', label: `Aktualisiere Cast-Mitglied: ${shorten(current.name, 60)}` });

  if (Object.keys(patch).length) await cast.updateMember(memberId, patch);
  for (const asset of images) {
    await cast.addMemberAsset(memberId, {
      kind: 'image',
      sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), asset.file),
      filename: asset.file
    });
  }
  if (voice) {
    await cast.addMemberAsset(memberId, {
      kind: 'voice',
      sourcePath: path.join(store.sessionAssetDir(ctx.sessionId), voice.file),
      filename: voice.file
    });
  }
  const saved = await cast.readMember(memberId);
  return {
    toolResult: `Cast-Mitglied ${saved.name} aktualisiert (ID ${saved.id}, ${saved.images.length} Bild(er), Stimme ${saved.voice ? 'vorhanden' : 'noch offen'}).`,
    inject: []
  };
}

const CAST_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

async function runImportCastAsset(ctx, args) {
  const folder = await requireProjectFolder(ctx);
  const memberId = await cast.resolveMemberId(folder, requiredString(args.member, 'member'));
  const member = await cast.readMember(memberId);
  const selector = requiredString(args.asset, 'asset');
  let filename;
  let kind;
  if (selector.toLowerCase() === 'voice') {
    if (!member.voice) throw new Error(`${member.name} hat noch keinen Voice-Master.`);
    filename = member.voice;
    kind = path.extname(filename).toLowerCase() === '.mp4' ? 'video' : 'audio';
  } else if (selector.toLowerCase().startsWith('image:')) {
    const requested = selector.slice(selector.indexOf(':') + 1).trim();
    if (/^\d+$/.test(requested)) filename = member.images[Number.parseInt(requested, 10) - 1];
    else filename = member.images.find((file) => file.toLowerCase() === requested.toLowerCase());
    if (!filename) throw new Error(`Cast-Bild ${requested} bei ${member.name} nicht gefunden.`);
    kind = 'image';
  } else {
    throw new Error("asset muss 'voice' oder 'image:<index|dateiname>' sein");
  }

  ctx.emit({ type: 'tool_start', tool: 'import_cast_asset', label: `Importiere Cast-Datei: ${member.name} / ${filename}` });
  const buffer = await cast.readMemberAsset(memberId, filename);
  const result = await storeImportedSessionAsset(ctx, {
    buffer,
    filename,
    prompt: `Cast-Import: ${member.name} / ${filename}`,
    sourceLabel: 'Cast-Datei',
    mimeType: CAST_IMAGE_MIME[path.extname(filename).toLowerCase()] || '',
    kind
  });
  if (kind === 'image') {
    result.toolResult += ` Nutze ${result.asset.id} in reference_asset_ids fuer das Aussehen von ${member.name}.`;
  } else if (kind === 'video') {
    result.toolResult += ` Nutze ${result.asset.id} in reference_video_asset_ids fuer Aussehen und Stimme von ${member.name}.`;
  } else {
    result.toolResult += ` Nutze ${result.asset.id} in reference_audio_asset_ids fuer die Stimme von ${member.name}.`;
  }
  return result;
}

function referenceIdArray(args, field, maxItems) {
  if (args[field] === undefined || args[field] === null) return [];
  if (!Array.isArray(args[field])) throw new Error(`${field} muss ein Array sein`);
  if (args[field].length > maxItems) {
    throw new Error(`generate_video akzeptiert maximal ${maxItems} ${field}`);
  }
  return args[field].map((value) => {
    const id = String(value || '').trim();
    if (!id) throw new Error(`${field} darf nur gueltige Asset-IDs enthalten`);
    return id;
  });
}

async function validateMediaReferenceAssets(sessionId, ids, allowedExtensions, label) {
  const ledger = await store.readLedger(sessionId);
  return ids.map((id) => {
    const asset = ledger.find((entry) => entry.id === id);
    if (!asset) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (asset.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    const ext = path.extname(asset.file).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(
        `Asset ${id} (${ext || 'ohne Endung'}) ist keine gueltige ${label}. ` +
          'Bilder gehoeren in reference_asset_ids.'
      );
    }
    return asset;
  });
}

async function removePublishedRefs(files) {
  await Promise.all((files || []).map((file) => publicrefs.removeRef(file).catch((err) => {
    console.warn(`[publicrefs] Referenz ${file} konnte nicht entfernt werden: ${err.message}`);
  })));
}

async function buildVideoPayload(ctx, args, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const refIds = referenceIdArray(args, 'reference_asset_ids', 30);
  const videoRefIds = referenceIdArray(args, 'reference_video_asset_ids', 10);
  const audioRefIds = referenceIdArray(args, 'reference_audio_asset_ids', 10);
  const firstFrameAssetId = String(args.first_frame_asset_id || '').trim();
  const mode = args.mode === 'image_to_video' || firstFrameAssetId ? 'image_to_video' : 'text_to_video';
  const capabilities = options.capabilities || await discovery.videoCapabilities(ctx.config.videoModel);
  const corrections = [];
  const supportedResolutions = Array.isArray(capabilities.resolutions) ? capabilities.resolutions : [];
  const fallbackResolution = supportedResolutions.includes('720p')
    ? '720p'
    : [...supportedResolutions].sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0] || '720p';
  const requestedResolution = typeof args.resolution === 'string' && args.resolution.trim()
    ? args.resolution.trim()
    : fallbackResolution;
  const resolution = supportedResolutions.includes(requestedResolution)
    ? requestedResolution
    : fallbackResolution;
  if (resolution !== requestedResolution) {
    corrections.push(`resolution ${requestedResolution} nicht unterstützt, auf ${resolution} korrigiert.`);
  }

  const payload = {
    model: ctx.config.videoModel,
    prompt,
    resolution
  };
  if (args.duration_seconds !== undefined && args.duration_seconds !== null) {
    const requestedDuration = Number(args.duration_seconds);
    if (Number.isFinite(requestedDuration)) {
      const roundedDuration = Math.round(requestedDuration);
      const minDuration = Number.isFinite(capabilities.durations?.min) ? capabilities.durations.min : 4;
      const maxDuration = Number.isFinite(capabilities.durations?.max) ? capabilities.durations.max : 30;
      const duration = Math.min(
        maxDuration,
        Math.max(minDuration, roundedDuration)
      );
      payload.duration = duration;
      if (duration !== requestedDuration) {
        corrections.push(`duration_seconds ${requestedDuration} auf ${duration} korrigiert.`);
      }
    }
  }

  const requestedAspectRatio = typeof args.aspect_ratio === 'string' ? args.aspect_ratio.trim() : '';
  if (mode === 'image_to_video') {
    if (!firstFrameAssetId) throw new Error('first_frame_asset_id fehlt fuer mode=image_to_video');
    if (requestedAspectRatio) {
      corrections.push('aspect_ratio bei Image-to-Video entfernt, da das Startbild das Format definiert.');
    }
  } else if (requestedAspectRatio) {
    if (Array.isArray(capabilities.aspectRatios) && capabilities.aspectRatios.includes(requestedAspectRatio)) {
      payload.aspect_ratio = requestedAspectRatio;
    } else {
      corrections.push(`aspect_ratio ${requestedAspectRatio} nicht unterstützt und weggelassen.`);
    }
  }

  if (mode === 'image_to_video') {
    await requireRasterAsset(ctx.sessionId, firstFrameAssetId);
    const url = await store.assetDataUrl(ctx.sessionId, firstFrameAssetId);
    payload.frame_images = [{ type: 'image_url', image_url: { url }, frame_type: 'first_frame' }];
  }
  if (refIds.length > 0) {
    payload.input_references = await referencesFromAssetIds(ctx.sessionId, refIds);
  }

  const publishedRefs = [];
  try {
    if (videoRefIds.length || audioRefIds.length) {
      if (!String(process.env.PUBLIC_BASE_URL || '').trim()) {
        throw new Error('Audio-/Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion). Bilder-Referenzen funktionieren weiterhin.');
      }
      await validateMediaReferenceAssets(
        ctx.sessionId,
        videoRefIds,
        new Set(['.mp4', '.webm']),
        'Video-Referenz (erlaubt: MP4 oder WebM)'
      );
      await validateMediaReferenceAssets(
        ctx.sessionId,
        audioRefIds,
        new Set(['.mp3', '.wav', '.m4a', '.aac']),
        'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)'
      );
    }
    const references = payload.input_references ? payload.input_references.slice() : [];
    for (const id of videoRefIds) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedRefs.push(published.file);
      references.push({ type: 'video_url', video_url: { url: published.url } });
    }
    for (const id of audioRefIds) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedRefs.push(published.file);
      references.push({ type: 'audio_url', audio_url: { url: published.url } });
    }
    if (references.length) payload.input_references = references;
    return { payload, prompt, mode, corrections, publishedRefs };
  } catch (err) {
    await removePublishedRefs(publishedRefs);
    throw err;
  }
}

async function runGenerateVideo(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  ctx.emit({ type: 'tool_start', tool: 'generate_video', label: `Starte Video: ${shorten(prompt, 90)}` });

  const built = await buildVideoPayload(ctx, args);
  const { payload, mode, corrections, publishedRefs } = built;

  let asset;
  try {
    asset = await store.reserveAsset(ctx.sessionId, { kind: 'video', ext: '.mp4', prompt });
  } catch (err) {
    await removePublishedRefs(publishedRefs);
    throw err;
  }
  let submitted;
  try {
    submitted = await or.createVideo(payload);
  } catch (err) {
    await removePublishedRefs(publishedRefs);
    await store.withLock(ctx.sessionId, async () => {
      const entries = await store.readLedger(ctx.sessionId);
      await store.writeLedger(
        ctx.sessionId,
        entries.filter((e) => e.id !== asset.id)
      );
    });
    throw err;
  }

  const jobId = submitted?.id;
  if (!jobId) {
    await removePublishedRefs(publishedRefs);
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error('Video-API lieferte keine Job-ID.');
  }

  const job = {
    jobId,
    assetId: asset.id,
    file: asset.file,
    status: submitted.status || 'pending',
    prompt,
    mode,
    model: ctx.config.videoModel,
    user: ctx.user || 'lokal',
    submittedAt: new Date().toISOString(),
    pollingUrl: submitted.polling_url || null,
    cost: null,
    error: null,
    publicRefFiles: publishedRefs
  };
  await store.mutateSession(ctx.sessionId, (session) => {
    session.jobs.push(job);
  });

  ctx.emit({ type: 'video_job', jobId, assetId: asset.id, prompt, status: job.status, source: null });

  return {
    toolResult: `Video-Job ${asset.id} gestartet (Job-ID ${jobId}, Modus ${mode}). Ergebnis folgt asynchron in einigen Minuten. Sag dem User kurz, was gerade generiert wird.${corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''}`,
    inject: [],
    job
  };
}

async function removeReservedAsset(sessionId, assetId) {
  await store.withLock(sessionId, async () => {
    const entries = await store.readLedger(sessionId);
    await store.writeLedger(
      sessionId,
      entries.filter((entry) => entry.id !== assetId)
    );
  });
}

async function renderAssetsFromIds(sessionId, rawIds) {
  if (rawIds === undefined || rawIds === null) return {};
  if (!Array.isArray(rawIds)) throw new Error('asset_ids muss ein Array sein');
  if (rawIds.length > MAX_RENDER_ASSETS) {
    throw new Error(`asset_ids darf hoechstens ${MAX_RENDER_ASSETS} Assets enthalten`);
  }

  const ids = [];
  const seen = new Set();
  for (const rawId of rawIds) {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      throw new Error('asset_ids darf nur nicht-leere Session-Asset-IDs enthalten');
    }
    const id = rawId.trim();
    if (!store.isValidId(id)) throw new Error(`Ungueltige Asset-ID: ${id}`);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  const ledger = await store.readLedger(sessionId);
  const assets = {};
  let totalBytes = 0;
  for (const id of ids) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);

    const storedFile = String(entry.file || '');
    if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
      throw new Error(`Asset ${id} hat einen ungueltigen Dateinamen.`);
    }
    const ext = path.extname(storedFile);
    if (!ext) throw new Error(`Asset ${id} hat keine Dateiendung.`);
    const filename = `${id}${ext}`;

    let buffer;
    try {
      buffer = await fsp.readFile(path.join(store.sessionAssetDir(sessionId), storedFile));
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_RENDER_ASSET_BYTES) {
      throw new Error('Die Render-Assets sind zusammen groesser als 24 MB.');
    }
    assets[filename] = buffer.toString('base64');
  }
  return assets;
}

async function runRenderMotionGraphics(ctx, args) {
  const html = String(args.html || '');
  const label = String(args.label || '').trim();
  const quality = args.quality === undefined || args.quality === null || args.quality === ''
    ? 'standard'
    : String(args.quality);
  const format = args.format === undefined || args.format === null || args.format === ''
    ? 'landscape'
    : String(args.format);
  if (!html.trim()) throw new Error('html fehlt');
  if (!label) throw new Error('label fehlt');
  if (!['draft', 'standard', 'high'].includes(quality)) {
    throw new Error('quality muss draft, standard oder high sein');
  }
  if (!Object.prototype.hasOwnProperty.call(RENDER_FORMATS, format)) {
    throw new Error('format muss landscape, portrait oder square sein');
  }
  const [formatWidth, formatHeight] = RENDER_FORMATS[format];
  const declaredWidth = html.match(/data-width\s*=\s*["'](\d+)["']/)?.[1];
  const declaredHeight = html.match(/data-height\s*=\s*["'](\d+)["']/)?.[1];
  if (declaredWidth !== String(formatWidth) || declaredHeight !== String(formatHeight)) {
    throw new Error(
      `Die Composition-Masse (data-width/data-height) muessen zum Format ${format} passen: ` +
        `${formatWidth}x${formatHeight}. Gefunden: ${declaredWidth || '?'}x${declaredHeight || '?'}. ` +
        'Bitte HTML anpassen (body/html-CSS und data-Attribute) und erneut rendern.'
    );
  }
  const assets = await renderAssetsFromIds(ctx.sessionId, args.asset_ids);

  ctx.emit({
    type: 'tool_start',
    tool: 'render_motion_graphics',
    label: `Rendere Motion Graphics: ${shorten(label, 90)}`
  });

  const asset = await store.reserveAsset(ctx.sessionId, {
    kind: 'video',
    ext: '.mp4',
    prompt: label
  });

  let submission;
  try {
    submission = await rendernode.submit(html, quality, assets, format);
  } catch (err) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  const { jobId, nodeId } = submission;

  const job = {
    jobId,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt: label,
    mode: 'motion_graphics',
    source: 'rendernode',
    renderNodeId: nodeId,
    model: 'hyperframes/rendernode',
    user: ctx.user || 'lokal',
    quality,
    format,
    submittedAt: new Date().toISOString(),
    pollingUrl: null,
    cost: null,
    error: null
  };
  await store.mutateSession(ctx.sessionId, (session) => {
    session.jobs.push(job);
  });

  await recordToolCost({
    ts: job.submittedAt,
    sessionId: ctx.sessionId,
    assetId: asset.id,
    type: 'motion',
    model: job.model,
    cost: 0,
    user: job.user
  });

  ctx.emit({
    type: 'video_job',
    jobId,
    assetId: asset.id,
    prompt: label,
    status: job.status,
    source: job.source,
    renderNodeId: nodeId
  });

  return {
    toolResult: `Motion-Graphics-Job ${asset.id} gestartet (Job-ID ${jobId}, Qualitaet ${quality}). Das Ergebnis folgt asynchron, typischerweise in wenigen Sekunden. Sag dem User kurz, was gerade gerendert wird.`,
    inject: [],
    job
  };
}

function requireHiggsfieldConnection() {
  if (!higgsfield.status().connected) throw new Error(higgsfield.DISCONNECTED_MESSAGE);
}

function truncateHiggsfieldText(value) {
  const text = String(value || '');
  return text.length > HIGGSFIELD_MODEL_TEXT_LIMIT
    ? `${text.slice(0, HIGGSFIELD_MODEL_TEXT_LIMIT - 14)}\n[… gekuerzt]`
    : text;
}

async function runHiggsfieldModels(_ctx, args) {
  requireHiggsfieldConnection();
  const model = String(args.model || '').trim();
  const goal = String(args.goal || '').trim();
  const payload = model
    ? { action: 'get', model_id: model }
    : goal
      ? { action: 'recommend', query: goal }
      : { action: 'list' };
  if (args.type) payload.type = String(args.type);
  return { toolResult: truncateHiggsfieldText(await higgsfield.mcpCall('models_explore', payload)), inject: [] };
}

function parseModelDetails(text, modelId) {
  try {
    const parsed = JSON.parse(String(text || ''));
    const items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [parsed];
    return items.find((item) => item?.id === modelId) || items[0] || null;
  } catch (_) {
    return null;
  }
}

function referenceRoleFromModel(model, outputKind) {
  const medias = Array.isArray(model?.medias) ? model.medias : [];
  const roles = medias
    .filter((media) => !media?.type || media.type === 'image')
    .flatMap((media) => Array.isArray(media?.roles) ? media.roles : [])
    .filter((role) => typeof role === 'string' && role.trim());
  const preferred = outputKind === 'video'
    ? ['start_image', 'first_frame', 'image', 'reference_image']
    : ['image', 'reference_image', 'input_image', 'subject'];
  return preferred.find((role) => roles.includes(role)) || roles[0] || 'image';
}

async function importHiggsfieldReferences(ctx, modelId, outputKind, rawIds) {
  const ids = referenceIdArray({ reference_asset_ids: rawIds }, 'reference_asset_ids', 12);
  if (!ids.length) return { medias: [], publishedFiles: [] };
  if (!String(process.env.PUBLIC_BASE_URL || '').trim()) {
    throw new Error('Higgsfield-Referenzen brauchen PUBLIC_BASE_URL (Produktion), damit Higgsfield die Session-Assets importieren kann.');
  }
  await validateMediaReferenceAssets(
    ctx.sessionId,
    ids,
    new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mp3', '.wav', '.m4a', '.aac']),
    'Higgsfield-Referenz'
  );

  let role = 'image';
  try {
    const modelText = await higgsfield.mcpCall('models_explore', { action: 'get', model_id: modelId });
    role = referenceRoleFromModel(parseModelDetails(modelText, modelId), outputKind);
  } catch (_) {
    /* Der sichere Higgsfield-Fallback fuer unklare Rollen ist "image". */
  }

  const publishedFiles = [];
  const medias = [];
  try {
    for (const id of ids) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedFiles.push(published.file);
      const imported = await higgsfield.mcpCall('media_import_url', { url: published.url });
      const mediaId = higgsfield.extractJobIds(imported)[0];
      if (!mediaId) throw new Error(`Higgsfield lieferte fuer Referenz ${id} keine media_id.`);
      medias.push({ value: mediaId, role });
    }
    return { medias, publishedFiles };
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    throw err;
  }
}

async function runHiggsfieldGeneration(ctx, args, kind) {
  requireHiggsfieldConnection();
  const model = String(args.model || '').trim();
  const prompt = String(args.prompt || '').trim();
  if (!model) throw new Error('model fehlt');
  if (!prompt) throw new Error('prompt fehlt');
  const tool = kind === 'image' ? 'higgsfield_generate_image' : 'higgsfield_generate_video';
  ctx.emit({
    type: 'tool_start',
    tool,
    label: `${kind === 'image' ? 'Starte Higgsfield-Bild' : 'Starte Higgsfield-Video'}: ${shorten(prompt, 80)}`
  });

  const refs = await importHiggsfieldReferences(ctx, model, kind, args.reference_asset_ids);
  const params = { model, prompt, use_unlim: false };
  if (args.aspect_ratio) params.aspect_ratio = String(args.aspect_ratio);
  if (args.resolution) params.resolution = String(args.resolution);
  if (kind === 'video' && args.duration !== undefined && args.duration !== null) {
    const duration = Number(args.duration);
    if (!Number.isInteger(duration)) {
      await removePublishedRefs(refs.publishedFiles);
      throw new Error('duration muss eine ganze Zahl sein');
    }
    params.duration = duration;
  }
  if (refs.medias.length) params.medias = refs.medias;

  let asset;
  try {
    asset = await store.reserveAsset(ctx.sessionId, {
      kind,
      ext: kind === 'image' ? '.png' : '.mp4',
      prompt
    });
  } catch (err) {
    await removePublishedRefs(refs.publishedFiles);
    throw err;
  }

  let submitText;
  try {
    submitText = await higgsfield.mcpCall(
      kind === 'image' ? 'generate_image_batch' : 'generate_video_batch',
      { requests: [{ index: 0, params }] }
    );
  } catch (err) {
    await removePublishedRefs(refs.publishedFiles);
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  await removePublishedRefs(refs.publishedFiles);

  const jobId = higgsfield.extractJobIds(submitText)[0];
  if (!jobId) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(`Higgsfield lieferte keine Job-ID: ${shorten(submitText, 500)}`);
  }
  const submittedAt = new Date().toISOString();
  const job = {
    jobId,
    provider: 'higgsfield',
    source: 'higgsfield',
    kind,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt,
    mode: kind === 'image' ? 'higgsfield_image' : 'higgsfield_video',
    model,
    user: ctx.user || 'lokal',
    submittedAt,
    timeoutAt: Date.now() + HIGGSFIELD_JOB_TIMEOUT_MS,
    cost: 0,
    costUnit: 'higgsfield_credits',
    error: null
  };
  await store.mutateSession(ctx.sessionId, (session) => session.jobs.push(job));
  await recordToolCost({
    ts: submittedAt,
    sessionId: ctx.sessionId,
    assetId: asset.id,
    type: 'higgsfield',
    model,
    cost: 0,
    user: job.user
  });

  ctx.emit({ type: 'generation_job', jobId, assetId: asset.id, prompt, status: job.status, source: 'higgsfield', kind });
  return {
    toolResult:
      `Higgsfield-${kind === 'image' ? 'Bild' : 'Video'}-Job ${asset.id} gestartet (Job-ID ${jobId}, Modell ${model}). ` +
      'Das Ergebnis folgt asynchron. Abrechnung erfolgt in Higgsfield-Credits; den aktuellen Stand zeigt higgsfield_check_balance.',
    inject: [],
    job
  };
}

function runHiggsfieldGenerateImage(ctx, args) {
  return runHiggsfieldGeneration(ctx, args, 'image');
}

function runHiggsfieldGenerateVideo(ctx, args) {
  return runHiggsfieldGeneration(ctx, args, 'video');
}

async function runHiggsfieldCheckBalance() {
  requireHiggsfieldConnection();
  return {
    toolResult: `${await higgsfield.mcpCall('balance', {})}\nAbrechnung: Higgsfield-Credits auf dem verbundenen Plan.`,
    inject: []
  };
}

async function runSaveMemory(_ctx, args) {
  const note = String(args.note || '').trim();
  if (!note) throw new Error('note fehlt');
  await store.appendBrainMemory(note);
  return { toolResult: 'Gemerkt.', inject: [] };
}

async function runSaveProjectMemory(ctx, args) {
  const session = await store.readSession(ctx.sessionId);
  const folder = typeof session.folder === 'string' ? session.folder.trim() : '';
  if (!folder) {
    throw new Error('Dieser Chat gehoert zu keinem Projekt - Projekt-Memory braucht ein Projekt. Fuer globale Learnings save_memory verwenden.');
  }
  const entry = await store.addFolderMemory(folder, args?.note);
  const profile = await store.readFolderProfile(folder);
  return {
    toolResult: `Im Projekt «${folder}» gespeichert: ${entry.note} (${profile?.memory.length || 0} Eintraege).`,
    inject: []
  };
}

const EXECUTORS = {
  generate_image: runGenerateImage,
  edit_image: runEditImage,
  generate_video: runGenerateVideo,
  generate_speech: runGenerateSpeech,
  list_voices: runListVoices,
  import_gts_asset: runImportGtsAsset,
  create_branding: runCreateBranding,
  update_branding: runUpdateBranding,
  add_branding_asset: runAddBrandingAsset,
  import_branding_asset: runImportBrandingAsset,
  create_cast_member: runCreateCastMember,
  update_cast_member: runUpdateCastMember,
  import_cast_asset: runImportCastAsset,
  render_motion_graphics: runRenderMotionGraphics,
  higgsfield_models: runHiggsfieldModels,
  higgsfield_generate_image: runHiggsfieldGenerateImage,
  higgsfield_generate_video: runHiggsfieldGenerateVideo,
  higgsfield_check_balance: runHiggsfieldCheckBalance,
  save_memory: runSaveMemory,
  save_project_memory: runSaveProjectMemory
};

async function executeTool(ctx, name, args) {
  const executor = EXECUTORS[name];
  if (!executor) throw new Error(`Unbekanntes Tool: ${name}`);
  return executor(ctx, args);
}

module.exports = { toolDefinitions, executeTool, shorten, buildVideoPayload };
