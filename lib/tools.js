'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const store = require('./store');
const access = require('./access');
const or = require('./openrouter');
const gts = require('./gts');
const brandings = require('./brandings');
const cast = require('./cast');
const discovery = require('./discovery');
const rendernode = require('./rendernode');
const costs = require('./costs');
const budget = require('./budget');
const settings = require('./settings');
const videoModels = require('./video-models');
const videoRefusal = require('./video-refusal');
const resultMeta = require('./result-meta');
const publicrefs = require('./publicrefs');
const elevenlabs = require('./elevenlabs');
const musicPlan = require('../public/nodes/music-plan');
const higgsfield = require('./higgsfield');
const fal = require('./fal');
const ffmpeg = require('./ffmpeg');
// Shared with the node view: HTML detection and the data-width / data-height check of a composition.
const motionHtml = require('../public/nodes/motion-html');

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const VIDEO_RESOLUTIONS = ['480p', '720p'];
const MAX_RENDER_ASSETS = 10;
const RENDER_FORMATS = motionHtml.FORMATS;
const MAX_RENDER_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_CONCAT_ASSETS = 20;
const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';
const HIGGSFIELD_MODEL_TEXT_LIMIT = 8000;
const HIGGSFIELD_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const HIGGSFIELD_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// fal.ai queue jobs (node view only): the poller gives up after this time, files above the upload cap are refused.
const FAL_JOB_TIMEOUT_MS = 90 * 60 * 1000;
const FAL_KINDS = Object.freeze(['video', 'image', 'audio', 'auto']);
const FAL_MAX_MEDIA_FILES = 30;
const FAL_MAX_INPUT_BYTES = 1024 * 1024;
const FAL_UPLOAD_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac'
});
const HIGGSFIELD_DEFAULT_AUDIO_MODEL = 'seed_audio';
// Speech models of the node view. The other audio models of the MCP (sonilo_music, mirelo_text_to_audio,
// inworld_text_to_speech) belong to the game pipeline and are not offered.
const HIGGSFIELD_SPEECH_MODELS = Object.freeze(['seed_audio', 'text2speech_v2']);
// seed_audio answers WAV by default and can also answer mp3, pcm and ogg_opus; the app stores wav and mp3 only.
const HIGGSFIELD_SPEECH_FORMATS = Object.freeze(['wav', 'mp3']);
// text2speech_v2 cannot run without one of these engines.
const HIGGSFIELD_SPEECH_VARIANTS = Object.freeze(['elevenlabs', 'minimax', 'seed_speech', 'vibe_voice', 'cozy_voice']);
// seed_audio takes 0..2 reference audios; video models with an audio role take up to 15 (the model's own limit is
// checked when the catalogue states it).
const HIGGSFIELD_MAX_SPEECH_REFS = 2;
const HIGGSFIELD_MAX_AUDIO_REFS = 15;
// The role of an audio reference when the model cannot be read; a readable model's own roles always win.
const HIGGSFIELD_AUDIO_REFERENCE_ROLE = 'audio_references';

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
        'Request an asynchronous video generation job. The app normally opens a model picker in the chat (compatible models, estimated price for exactly these arguments, strengths and weaknesses) and ends your turn; only the user\'s click starts the paid job, so do not call this tool again while the picker waits and do not ask for the model in text. Where this user has already chosen a model for the chat, the job starts right away with it. Image references preserve appearance. A video reference preserves BOTH appearance and voice; an audio reference preserves voice/sound only. For recurring characters, ALWAYS reuse the same master clip in every shot.',
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

const CONCAT_VIDEOS_DEFINITION = {
  type: 'function',
  function: {
    name: 'concat_videos',
    description:
      'Concatenate finished session video clips in the given order into one final export. Use this for final episode assembly and simple joins instead of render_motion_graphics. There is no practical clip-size limit; compatible clips are joined losslessly and quickly, while incompatible clips are automatically normalised and re-encoded.',
    parameters: {
      type: 'object',
      properties: {
        asset_ids: {
          type: 'array',
          minItems: 2,
          maxItems: MAX_CONCAT_ASSETS,
          items: { type: 'string' },
          description: 'Two to twenty ready session video asset IDs in final playback order.'
        },
        label: {
          type: 'string',
          description: 'Optional short human-readable German label for the final video.'
        }
      },
      required: ['asset_ids'],
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

// Participants and guests (lib/access.js) get no Higgsfield (credits of the operator), no GTS knowledge base and no
// brandings (internal resources). executeTool enforces the same list; here the tools just are not offered.
const HIGGSFIELD_TOOL_NAMES = new Set([
  'higgsfield_models',
  'higgsfield_generate_image',
  'higgsfield_generate_video',
  'higgsfield_check_balance',
  'higgsfield_edit',
  'higgsfield_speech'
]);
const INTERNAL_RESOURCE_TOOLS = Object.freeze({
  import_gts_asset: 'gts',
  create_branding: 'brandings',
  update_branding: 'brandings',
  add_branding_asset: 'brandings',
  import_branding_asset: 'brandings'
});
// Tools that cost money or use an account of the operator. Their price is not known before the call (except
// fal_generate, whose caller passes estimateUsd); everything else is free or local.
const PAID_TOOLS = new Set(['generate_image', 'edit_image', 'generate_video', 'generate_speech', 'generate_music', 'fal_generate']);
// Paid tools that start a provider job booked only when it is done (the poller). Their grant keeps a reservation with the
// job (a flat one where the price is unknown) and a person may have only a few open at once (lib/budget.js).
const ASYNC_PAID_TOOLS = new Set(['generate_video', 'fal_generate']);

function toolDefinitions(viewer = null) {
  const restricted = access.isRestricted(viewer);
  const definitions = BASE_TOOL_DEFINITIONS.slice();
  if (rendernode.enabled()) definitions.push(RENDER_MOTION_GRAPHICS_DEFINITION);
  if (ffmpeg.binaries().available) definitions.push(CONCAT_VIDEOS_DEFINITION);
  if (higgsfield.status().connected && !restricted) definitions.push(...HIGGSFIELD_TOOL_DEFINITIONS);
  return restricted
    ? definitions.filter((definition) => !Object.prototype.hasOwnProperty.call(INTERNAL_RESOURCE_TOOLS, definition.function?.name))
    : definitions;
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

// ctx.budgetKey: the reservation of the node run the cost belongs to (lib/budget.js); it shrinks by what was booked.
async function recordToolCost(entry, ctx = null) {
  try {
    await costs.recordCost(entry);
    if (ctx && ctx.budgetKey) budget.settle(ctx.budgetKey, entry.cost);
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
  return storeImageResult(ctx, result, prompt, payload.model);
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
  return storeImageResult(ctx, result, prompt, payload.model);
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
  // Participants and guests: only the library voices, not the cloned voices of the operator's account.
  if (access.isRestricted(viewerOfCtx(ctx)) && voiceId !== DEFAULT_ELEVENLABS_VOICE_ID) {
    const allowed = await libraryVoices();
    if (!allowed.some((voice) => voice.voice_id === voiceId)) {
      throw new access.RoleRestrictedError('voices', 'This voice is not available for your account', 'Diese Stimme ist für dein Konto nicht verfügbar.');
    }
  }

  ctx.emit({
    type: 'tool_start',
    tool: 'generate_speech',
    label: `Erzeuge Sprache mit ElevenLabs: ${shorten(text, 80)}`
  });
  const buffer = await elevenlabs.tts({ text, voiceId, modelId });
  if (!buffer.length) throw new Error('ElevenLabs lieferte eine leere Audio-Datei.');
  // The estimate is booked for everybody, internal people included, so the cost overview shows what ElevenLabs costs;
  // for a participant it is also what counts against the budget.
  const speechCost = speechEstimateUsd(text);
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'audio',
    buffer,
    ext: '.mp3',
    prompt: `ElevenLabs Sprache: ${shorten(text, 160)}`,
    cost: speechCost,
    costEstimated: speechCost !== null,
    model: `elevenlabs/${modelId}`
  });
  if (speechCost !== null) {
    await recordToolCost(
      {
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        assetId: asset.id,
        type: 'speech',
        model: `elevenlabs/${modelId}`,
        cost: speechCost,
        billing: 'Schaetzung (Zeichen)',
        user: ctx.user || 'lokal'
      },
      ctx
    );
  }
  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'audio', prompt: asset.prompt, cost: speechCost, ...(speechCost !== null ? { costEstimated: true } : {}), ...resultMeta.describe(asset) }
  });
  return {
    toolResult:
      `Sprache erzeugt: ${asset.id} (${characters.length} Zeichen). ` +
      `Nutze ${asset.id} als Voice-Master beim Casting oder in reference_audio_asset_ids fuer Seedance.`,
    inject: [],
    asset
  };
}

// The code and the values of the first problem of a plan text (public/nodes/music-plan.js): the node shows the cause in
// the interface language, with the line number.
function musicPlanError(problem) {
  const err = new Error(problem.message);
  err.code = problem.code;
  err.data = { ...problem.data };
  return err;
}

// What a generate_music call is about: a plan text (plan_text, the length comes from its sections) or a description
// (prompt with length_seconds and instrumental). Throws for anything the API would refuse.
function musicRequest(args) {
  const modelId = String(args?.model_id || elevenlabs.DEFAULT_MUSIC_MODEL_ID).trim();
  if (!elevenlabs.MUSIC_MODELS.includes(modelId)) throw new Error(`model_id: unbekanntes Musikmodell ${modelId}`);
  const planText = String(args?.plan_text || '').trim();
  if (planText) {
    const { plan, errors } = musicPlan.parse(planText, { model: modelId });
    const problem = errors[0];
    if (problem) throw musicPlanError(problem);
    return { mode: 'plan', modelId, lengthMs: musicPlan.totalMs(plan), compositionPlan: musicPlan.toApi(plan, modelId), summary: plan.positive.join(', ') || plan.sections.map((section) => section.name).filter(Boolean).join(', ') };
  }
  const prompt = String(args?.prompt || '').trim();
  if (!prompt) throw new Error('prompt oder plan_text fehlt');
  const seconds = Number(args?.length_seconds);
  const lengthMs = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || lengthMs < elevenlabs.MUSIC_MIN_MS || lengthMs > elevenlabs.MUSIC_MAX_MS) {
    throw new Error(`length_seconds muss zwischen ${elevenlabs.MUSIC_MIN_MS / 1000} und ${elevenlabs.MUSIC_MAX_MS / 1000} liegen`);
  }
  return { mode: 'prompt', modelId, prompt, lengthMs, instrumental: args?.instrumental === true, summary: prompt };
}

// Node view only (NODE_ONLY_TOOLS), paid: the estimate by minute is reserved and booked for everybody as a cost of the type music.
async function runGenerateMusic(ctx, args) {
  requireElevenLabsKey();
  const request = musicRequest(args);
  const seconds = Math.round(request.lengthMs / 100) / 10;
  ctx.emit({
    type: 'tool_start',
    tool: 'generate_music',
    label: `Erzeuge Musik mit ElevenLabs (${seconds} s): ${shorten(request.summary, 80)}`
  });
  const buffer = await elevenlabs.composeMusic(
    request.mode === 'plan'
      ? { compositionPlan: request.compositionPlan, modelId: request.modelId }
      : { prompt: request.prompt, lengthMs: request.lengthMs, instrumental: request.instrumental, modelId: request.modelId }
  );
  if (!buffer.length) throw new Error('ElevenLabs lieferte eine leere Audio-Datei.');
  const musicCost = musicEstimateUsd(request.lengthMs);
  const model = `elevenlabs/${request.modelId}`;
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'audio',
    buffer,
    ext: '.mp3',
    prompt: `ElevenLabs Musik: ${shorten(request.summary, 160)}`,
    cost: musicCost,
    costEstimated: musicCost !== null,
    model
  });
  if (musicCost !== null) {
    await recordToolCost(
      {
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        assetId: asset.id,
        type: 'music',
        model,
        cost: musicCost,
        billing: 'Schaetzung (Dauer)',
        user: ctx.user || 'lokal'
      },
      ctx
    );
  }
  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'audio', prompt: asset.prompt, cost: musicCost, ...(musicCost !== null ? { costEstimated: true } : {}), ...resultMeta.describe(asset) }
  });
  return { toolResult: `Musik erzeugt: ${asset.id} (${seconds} Sekunden).`, inject: [], asset };
}

// Node view only, free of credits: song text and structure for an idea, as the readable plan text.
async function runPlanMusic(ctx, args) {
  requireElevenLabsKey();
  const prompt = String(args?.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const modelId = String(args?.model_id || elevenlabs.DEFAULT_MUSIC_MODEL_ID).trim();
  if (!elevenlabs.MUSIC_MODELS.includes(modelId)) throw new Error(`model_id: unbekanntes Musikmodell ${modelId}`);
  let lengthMs;
  if (args?.length_seconds !== undefined && args.length_seconds !== null && args.length_seconds !== '') {
    lengthMs = Math.round(Number(args.length_seconds) * 1000);
    if (!(lengthMs >= elevenlabs.MUSIC_MIN_MS && lengthMs <= elevenlabs.MUSIC_MAX_MS)) {
      throw new Error(`length_seconds muss zwischen ${elevenlabs.MUSIC_MIN_MS / 1000} und ${elevenlabs.MUSIC_MAX_MS / 1000} liegen`);
    }
  }
  ctx.emit({ type: 'tool_start', tool: 'plan_music', label: `Plane Songtext und Aufbau mit ElevenLabs: ${shorten(prompt, 80)}` });
  const api = await elevenlabs.planMusic({ prompt, lengthMs, modelId });
  const plan = musicPlan.fromApi(api);
  const planText = musicPlan.stringify(plan);
  return { toolResult: `Songtext und Aufbau (${plan.sections.length} Abschnitte):\n${planText}`, inject: [], planText, plan };
}

function voiceLabels(labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return '';
  const entries = Object.entries(labels)
    .filter(([key, value]) => key && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .map(([key, value]) => `${key}=${value}`);
  return entries.length ? ` (${entries.join(', ')})` : '';
}

// The voices of ElevenLabs' own library (category "premade"): what participants may use.
async function libraryVoices() {
  return (await elevenlabs.listVoices()).filter((voice) => voice.category === 'premade');
}

async function runListVoices(ctx) {
  requireElevenLabsKey();
  ctx.emit({ type: 'tool_start', tool: 'list_voices', label: 'Lade ElevenLabs-Stimmen' });
  const voices = access.isRestricted(viewerOfCtx(ctx)) ? await libraryVoices() : await elevenlabs.listVoices();
  const lines = voices.map((voice) => `- ${voice.name}: ${voice.voice_id}${voiceLabels(voice.labels)}`);
  return {
    toolResult: lines.length
      ? `Verfuegbare ElevenLabs-Stimmen (${lines.length}):\n${lines.join('\n')}`
      : 'ElevenLabs meldet keine verfuegbaren Stimmen.',
    inject: []
  };
}

// Shared image post-processing: save file, emit asset, inject preview for the brain.
async function storeImageResult(ctx, result, prompt, model) {
  const item = result?.data?.[0];
  if (!item?.b64_json) throw new Error('Antwort der Bild-API enthielt keine Bilddaten.');
  const cost = typeof result?.usage?.cost === 'number' ? result.usage.cost : null;
  const buffer = Buffer.from(item.b64_json, 'base64');
  const asset = await store.saveAsset(ctx.sessionId, {
    kind: 'image',
    buffer,
    ext: extFromMediaType(item.media_type),
    prompt,
    cost,
    model
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
    }, ctx);
  }

  ctx.emit({
    type: 'asset',
    asset: { id: asset.id, url: asset.url, kind: 'image', prompt, cost: asset.cost, ...resultMeta.describe(asset) }
  });

  return {
    toolResult: `Bild erzeugt: ${asset.id} (Datei ${asset.file}). Das Bild wird dir direkt im Anschluss zur Pruefung gezeigt.`,
    inject: [
      {
        role: 'user',
        hidden: true,
        content: [
          { type: 'text', text: `[System] Automatische Vorschau von ${asset.id} zur Pruefung:` },
          // Verweis statt base64: die Datei liegt bereits im Session-Asset-Ordner.
          { type: 'image_ref', file: asset.file, mime: item.media_type || 'image/png' }
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

const { assertNoExternalReferences } = require('./svg-safe');

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
  let previewId = asset.id;
  let previewFile = asset.file;
  let rasterAsset = null;

  // SVGs koennen die Bild-/Video-APIs nicht verarbeiten - zusaetzlich als PNG rastern.
  if (ext === '.svg') {
    try {
      assertNoExternalReferences(buffer.toString('utf8'));
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
      previewId = pngAsset.id;
      previewFile = pngAsset.file;
      rasterAsset = pngAsset;
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
            { type: 'image_ref', file: previewFile, mime: previewMime }
          ]
        }
      ]
    : [];

  // rasterAsset = PNG variant of an imported SVG (null otherwise); the node view uses it for SVG uploads.
  return {
    toolResult,
    inject,
    asset,
    rasterAsset
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

// User management: who is calling? ctx.user is the address the external login reported ('lokal' or unset = nobody).
// In the local mode everybody is an admin. The chat tools must not be a way around the admin-only routes.
function viewerOfCtx(ctx) {
  return ctx?.viewer || access.viewerOf({ kubleUser: ctx?.user });
}

// Brandings are global and attached to every project; importing and deleting them is admin-only, so changing them
// through the Director is as well (as soon as the user management is active).
function requireBrandingAdmin(ctx, tool) {
  if (viewerOfCtx(ctx).admin) return;
  throw new Error(`${tool} ist nur fuer Admins verfuegbar: Brandings gelten fuer alle Projekte. Bitte einen Admin bitten, das Branding anzulegen oder zu aendern.`);
}

async function runCreateBranding(ctx, args) {
  requireBrandingAdmin(ctx, 'create_branding');
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
  requireBrandingAdmin(ctx, 'update_branding');
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
  requireBrandingAdmin(ctx, 'add_branding_asset');
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
  // Participants and guests may change the cast only in a project of their own (in a shared chat of somebody else
  // the project, and its cast, belongs to the owner and stays invisible to them).
  const viewer = viewerOfCtx(ctx);
  if (access.isRestricted(viewer) && (!viewer.email || (await store.folderOwner(folder)) !== viewer.email)) {
    throw new access.RoleRestrictedError(
      'cast',
      'The cast of this project is not available for your account',
      'Der Cast dieses Projekts ist für dein Konto nicht verfügbar.'
    );
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
  const referenceLimits = videoModels.referenceLimits(ctx.config.videoModel);
  // Off for the node view and for the old way without the picker (ctx.skipVideoModelLimits), which keep their own limits.
  if (referenceLimits && !options.skipModelLimits && ctx.skipVideoModelLimits !== true && ctx.nodeView !== true) {
    // The model picker only offers models that take the references of the job; this is the same rule for a direct call.
    const modelName = ctx.config.videoModel;
    if (refIds.length > referenceLimits.images) {
      throw new Error(`${modelName} nimmt hoechstens ${referenceLimits.images} Referenzbilder (angegeben: ${refIds.length}).`);
    }
    if (videoRefIds.length > referenceLimits.videos) {
      throw new Error(`${modelName} nimmt hoechstens ${referenceLimits.videos} Video-Referenzen (angegeben: ${videoRefIds.length}).`);
    }
    if (audioRefIds.length > referenceLimits.audios) {
      throw new Error(`${modelName} nimmt hoechstens ${referenceLimits.audios} Audio-Referenzen (angegeben: ${audioRefIds.length}).`);
    }
  }
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

// What a job carries so the poller can settle the reservation of a participant when the cost arrives.
function budgetFieldsOf(ctx) {
  const grant = ctx && ctx.budgetGrant;
  return grant && grant.jobKey ? { budgetKey: grant.jobKey, ...(grant.reservedUsd > 0 ? { reservedUsd: grant.reservedUsd } : {}) } : {};
}

// What can be checked without a model and without publishing anything: a card must not open for a job that could never
// start (a missing first frame, an asset that is not there, references the server cannot publish).
async function precheckVideoArgs(ctx, args) {
  const refIds = referenceIdArray(args, 'reference_asset_ids', 30);
  const videoRefIds = referenceIdArray(args, 'reference_video_asset_ids', 10);
  const audioRefIds = referenceIdArray(args, 'reference_audio_asset_ids', 10);
  const firstFrameAssetId = String(args.first_frame_asset_id || '').trim();
  if ((args.mode === 'image_to_video' || firstFrameAssetId) && !firstFrameAssetId) {
    throw new Error('first_frame_asset_id fehlt fuer mode=image_to_video');
  }
  const ledger = await store.readLedger(ctx.sessionId);
  for (const id of [firstFrameAssetId, ...refIds].filter(Boolean)) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    await requireRasterAsset(ctx.sessionId, id);
  }
  if (videoRefIds.length || audioRefIds.length) {
    if (!String(process.env.PUBLIC_BASE_URL || '').trim()) {
      throw new Error('Audio-/Video-Referenzen brauchen PUBLIC_BASE_URL (Produktion). Bilder-Referenzen funktionieren weiterhin.');
    }
    await validateMediaReferenceAssets(ctx.sessionId, videoRefIds, new Set(['.mp4', '.webm']), 'Video-Referenz (erlaubt: MP4 oder WebM)');
    await validateMediaReferenceAssets(ctx.sessionId, audioRefIds, new Set(['.mp3', '.wav', '.m4a', '.aac']), 'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)');
  }
}

// What the job remembers of the choice that started it: the readable name of the model and the estimate the card showed
// (the upper end is what the budget reserves), so the running job can say "about $0.84".
function videoEstimateFields(option) {
  const fields = {};
  if (option.name) fields.modelName = resultMeta.stripProvider(option.name);
  if (Number.isFinite(option.estimateUsd) && option.estimateUsd >= 0) fields.estimateUsd = option.estimateUsd;
  const min = option.price && option.price.minTotal;
  if (Number.isFinite(min) && min >= 0 && Number.isFinite(option.estimateUsd) && min < option.estimateUsd) fields.estimateMinUsd = min;
  return fields;
}

// The fields of a job the chat shows (live events carry the same as the job list of the server).
function jobMetaFields(job) {
  const billing = resultMeta.billingOf(job);
  return {
    ...resultMeta.describe(job),
    ...(Number.isFinite(job.estimateUsd) ? { estimateUsd: job.estimateUsd } : {}),
    ...(Number.isFinite(job.estimateMinUsd) ? { estimateMinUsd: job.estimateMinUsd } : {}),
    ...(billing ? { billing } : {})
  };
}

function formatUsdRange(price) {
  if (!price) return null;
  const money = (value) => `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
  return Math.abs(price.maxTotal - price.minTotal) > 0.005 ? `${money(price.minTotal)}-${money(price.maxTotal)}` : money(price.minTotal);
}

// The chat asks for the model first (lib/video-models.js): this stores the request, shows the card and ends the turn.
// The job starts later from the click (server.js), which calls this tool again with ctx.selectedVideoModel.
async function openVideoModelChoice(ctx, args, prompt) {
  const plan = ctx.videoPlan;
  const request = await videoModels.createRequest({ sessionId: ctx.sessionId, args, plan, user: ctx.user });
  const choice = videoModels.publicChoice(request, plan.budgetStatus || null);
  ctx.emit({ type: 'video_model_choice', choice });
  const names = request.options.map((option) => option.name).join(', ');
  return {
    toolResult:
      `Video-Modellwahl ${request.id} wartet auf den User (Modelle: ${names}). Es wurde noch nichts gestartet und nichts berechnet. ` +
      'Der User waehlt in der Oberflaeche ein Modell; erst sein Klick startet die kostenpflichtige Erzeugung. ' +
      (request.refusedProviders && request.refusedProviders.length
        ? `Die Modelle von ${request.refusedProviders.join(', ')} sind gesperrt, weil dieser Anbieter das Bild abgelehnt hat (echte Person moeglich). `
        : '') +
      'Rufe generate_video nicht erneut auf, solange die Auswahl wartet, und frage nicht zusaetzlich im Text nach dem Modell.',
    inject: [{
      role: 'assistant',
      hidden: true,
      videoModelRequestId: request.id,
      content: `[System] Warte auf die Video-Modellwahl ${request.id} durch den User. Prompt: ${shorten(prompt, 120)}`
    }],
    videoModelChoiceId: request.id,
    halt: true
  };
}

async function runGenerateVideo(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  if (ctx.videoPlan && ctx.videoPlan.kind === 'card' && !ctx.selectedVideoModel) {
    await precheckVideoArgs(ctx, args);
    return openVideoModelChoice(ctx, args, prompt);
  }
  ctx.emit({ type: 'tool_start', tool: 'generate_video', label: `Starte Video: ${shorten(prompt, 90)}` });

  const built = await buildVideoPayload(ctx, args);
  const { payload, mode, corrections, publishedRefs } = built;

  let asset;
  try {
    asset = await store.reserveAsset(ctx.sessionId, {
      kind: 'video',
      ext: '.mp4',
      prompt,
      model: ctx.config.videoModel,
      modelName: ctx.videoOption ? ctx.videoOption.name : undefined
    });
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
    // A refused image (real person): one stable error with readable texts instead of the raw provider answer. The
    // refusal came at the start, so no job exists and the budget reservation is released by executeTool.
    const refusal = videoRefusal.refusalOf(err, { model: payload.model });
    if (!refusal) throw err;
    // A model remembered for the chat started without the card: remember the refusal for these images, so that the next
    // call opens the card with the provider marked instead of starting the same model again.
    if (ctx.videoPlan && ctx.videoPlan.kind === 'direct' && !ctx.selectedVideoModel) {
      await videoModels.rememberImageRefusal({ sessionId: ctx.sessionId, args, provider: refusal.provider }).catch(() => {});
    }
    throw refusal;
  }

  const jobId = submitted?.id;
  if (!jobId) {
    await removePublishedRefs(publishedRefs);
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error('Video-API lieferte keine Job-ID.');
  }

  const submittedAt = new Date().toISOString();
  const job = {
    jobId,
    assetId: asset.id,
    file: asset.file,
    status: submitted.status || 'pending',
    prompt,
    mode,
    model: ctx.config.videoModel,
    ...(ctx.videoOption ? videoEstimateFields(ctx.videoOption) : {}),
    user: ctx.user || 'lokal',
    submittedAt,
    createdAt: submittedAt,
    startedAt: ['running', 'in_progress', 'processing'].includes(String(submitted.status || '').toLowerCase())
      ? submittedAt
      : null,
    pollingUrl: submitted.polling_url || null,
    cost: null,
    error: null,
    publicRefFiles: publishedRefs,
    ...(ctx.videoModelRequestId ? { videoModelRequestId: ctx.videoModelRequestId } : {}),
    ...budgetFieldsOf(ctx)
  };
  await store.mutateSession(ctx.sessionId, (session) => {
    session.jobs.push(job);
  });

  ctx.emit({
    type: 'video_job',
    jobId,
    assetId: asset.id,
    prompt,
    status: job.status,
    source: null,
    provider: null,
    kind: 'video',
    model: job.model,
    ...jobMetaFields(job),
    createdAt: submittedAt,
    startedAt: job.startedAt
  });

  const plan = ctx.videoPlan;
  const estimate = plan && plan.kind === 'direct' ? formatUsdRange(plan.option.price) : null;
  const remembered = plan && plan.kind === 'direct'
    ? ` Der User hat fuer diesen Chat ${plan.option.name} (${job.model}) gewaehlt; es wurde ohne Rueckfrage damit gestartet. ` +
      `Nenne dem User Modell und geschaetzten Preis${estimate ? ` (${estimate} fuer ${plan.option.durationSeconds} s)` : ' (Preis unbekannt)'}.`
    : '';
  return {
    toolResult: `Video-Job ${asset.id} gestartet (Job-ID ${jobId}, Modus ${mode}, Modell ${job.model}). Ergebnis folgt asynchron in einigen Minuten. Sag dem User kurz, was gerade generiert wird.${remembered}${corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''}`,
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
  if (rawIds === undefined || rawIds === null) return { files: [], totalBytes: 0 };
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
  const files = [];
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

    let stat;
    const filePath = path.join(store.sessionAssetDir(sessionId), storedFile);
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    if (!stat.isFile()) throw new Error(`Asset ${id} konnte nicht gelesen werden: keine Datei.`);
    totalBytes += stat.size;
    if (totalBytes > MAX_RENDER_ASSET_BYTES) {
      throw new Error('Die Render-Assets sind zusammen groesser als 500 MB.');
    }
    files.push({ filename, path: filePath, size: stat.size });
  }
  return { files, totalBytes };
}

function validateConcatArgs(args) {
  if (!Array.isArray(args?.asset_ids)) throw new Error('asset_ids muss ein Array sein');
  if (args.asset_ids.length < 2 || args.asset_ids.length > MAX_CONCAT_ASSETS) {
    throw new Error(`asset_ids muss 2 bis ${MAX_CONCAT_ASSETS} Video-Assets enthalten`);
  }
  return args.asset_ids.map((rawId) => {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      throw new Error('asset_ids darf nur nicht-leere Session-Asset-IDs enthalten');
    }
    const id = rawId.trim();
    if (!store.isValidId(id)) throw new Error(`Ungueltige Asset-ID: ${id}`);
    return id;
  });
}

async function concatVideoSources(sessionId, ids) {
  const ledger = await store.readLedger(sessionId);
  const directory = store.sessionAssetDir(sessionId);
  const sources = [];
  for (const id of ids) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    if (entry.kind !== 'video') throw new Error(`Asset ${id} ist kein Video-Asset.`);
    const storedFile = String(entry.file || '');
    if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
      throw new Error(`Asset ${id} hat einen ungueltigen Dateinamen.`);
    }
    const file = path.join(directory, storedFile);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('keine Datei');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    sources.push(file);
  }
  return sources;
}

async function runConcatVideos(ctx, args) {
  const ids = validateConcatArgs(args);
  const label = String(args.label || '').trim() || 'Finaler Zusammenschnitt';
  const binaries = ffmpeg.binaries();
  if (!binaries.available) throw new Error('concat_videos ist nicht verfuegbar, weil ffmpeg oder ffprobe fehlt.');
  const sources = await concatVideoSources(ctx.sessionId, ids);
  const startedAt = Date.now();
  const deadline = startedAt + ffmpeg.PROCESS_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());

  ctx.emit({
    type: 'tool_start',
    tool: 'concat_videos',
    label: `Fuege Videos zusammen: ${shorten(label, 90)}`
  });

  const scratch = await fsp.mkdtemp(path.join(store.sessionAssetDir(ctx.sessionId), '.concat-'));
  const outputFile = path.join(scratch, 'output.mp4');
  const listFile = path.join(scratch, 'inputs.txt');
  let reserved = null;
  try {
    const probes = [];
    for (const source of sources) {
      probes.push(await ffmpeg.probeVideo(source, {
        ffprobePath: binaries.ffprobe,
        timeoutMs: Math.min(30000, remaining())
      }));
    }
    let strategy = ffmpeg.concatStrategy(probes);
    try {
      await ffmpeg.concatVideos({
        files: sources,
        probes,
        outputFile,
        listFile,
        strategy,
        ffmpegPath: binaries.ffmpeg,
        timeoutMs: remaining()
      });
    } catch (err) {
      if (strategy !== 'copy' || Date.now() >= deadline) throw err;
      strategy = 'reencode';
      await fsp.rm(outputFile, { force: true });
      await ffmpeg.concatVideos({
        files: sources,
        probes,
        outputFile,
        listFile,
        strategy,
        ffmpegPath: binaries.ffmpeg,
        timeoutMs: remaining()
      });
    }
    const finalProbe = await ffmpeg.probeVideo(outputFile, {
      ffprobePath: binaries.ffprobe,
      timeoutMs: Math.min(30000, remaining())
    });
    reserved = await store.reserveAsset(ctx.sessionId, {
      kind: 'video',
      ext: '.mp4',
      prompt: label
    });
    const asset = await store.completeAssetFile(ctx.sessionId, reserved.id, outputFile, {
      cost: 0,
      duration: finalProbe.duration
    });
    await recordToolCost({
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      assetId: asset.id,
      type: 'video',
      model: 'ffmpeg',
      cost: 0,
      user: ctx.user || 'lokal',
      billing: 'local'
    });
    return {
      toolResult:
        `Videos als ${asset.id} zusammengefuegt (${strategy === 'copy' ? 'verlustfrei' : 'neu kodiert'}, ` +
        `${finalProbe.duration ? `${finalProbe.duration.toFixed(1)} s` : 'Dauer unbekannt'}).`,
      inject: [],
      asset: { id: asset.id, url: asset.url, kind: 'video', prompt: asset.prompt, cost: 0 }
    };
  } catch (err) {
    if (reserved) await removeReservedAsset(ctx.sessionId, reserved.id);
    throw err;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

// German error text for a failed motionHtml.checkComposition() result (ASCII umlauts like the rest of this file).
function compositionProblemMessage(problem) {
  const { format, width, height } = problem;
  const root =
    `<div id="main-composition" data-composition-id="main" data-width="${width}" data-height="${height}" ` +
    'data-start="0" data-duration="SEKUNDEN">...</div>';
  if (problem.code === 'not_html') {
    return (
      'Kein HTML: Der uebergebene Text enthaelt kein HTML-Tag, er ist eine Anweisung oder Beschreibung und kein Code. ' +
      `Erwartet wird eine vollstaendige HTML/GSAP-Komposition mit dem Wurzel-Element ${root} ` +
      '(Format ' + format + ', ' + width + 'x' + height + '). ' +
      'Videos aneinanderzuhaengen geht mit concat_videos (Node "Videos aneinanderhaengen"); ' +
      'fuer eine Animation aus einer Beschreibung zuerst den HTML-Code schreiben lassen (Node "Motion-HTML-Autor") und diesen Code hier uebergeben.'
    );
  }
  return (
    `Die Composition-Masse (data-width/data-height) muessen zum Format ${format} passen: ` +
    `${width}x${height}. Gefunden: ${problem.foundWidth || '?'}x${problem.foundHeight || '?'}. ` +
    `Das Wurzel-Element braucht data-width="${width}" und data-height="${height}", zum Beispiel ${root}. ` +
    'Bitte HTML anpassen (body/html-CSS und data-Attribute) und erneut rendern.'
  );
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
  const problem = motionHtml.checkComposition(html, format);
  if (problem) throw new Error(compositionProblemMessage(problem));
  const assets = await renderAssetsFromIds(ctx.sessionId, args.asset_ids);

  ctx.emit({
    type: 'tool_start',
    tool: 'render_motion_graphics',
    label: `Rendere Motion Graphics: ${shorten(label, 90)}`
  });

  const asset = await store.reserveAsset(ctx.sessionId, {
    kind: 'video',
    ext: '.mp4',
    prompt: label,
    model: 'hyperframes/rendernode'
  });

  let submission;
  try {
    submission = await rendernode.submit(html, quality, assets, format);
  } catch (err) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  const { jobId, nodeId } = submission;
  const nodeName = rendernode.listConfiguredNodes().find((node) => node.id === nodeId)?.name || null;

  const submittedAt = new Date().toISOString();
  const job = {
    jobId,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt: label,
    mode: 'motion_graphics',
    source: 'rendernode',
    renderNodeId: nodeId,
    nodeName,
    model: 'hyperframes/rendernode',
    user: ctx.user || 'lokal',
    quality,
    format,
    submittedAt,
    createdAt: submittedAt,
    startedAt: null,
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
    provider: 'rendernode',
    kind: 'video',
    ...jobMetaFields(job),
    renderNodeId: nodeId,
    nodeId,
    nodeName,
    createdAt: submittedAt,
    startedAt: null
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

// Parses JSON that may be followed by extra prose (models_explore appends e.g. "Unlim configs" text).
function parseJsonLoose(text) {
  const raw = String(text || '');
  try {
    return JSON.parse(raw);
  } catch (_) {
    /* fall through to the balanced-prefix scan */
  }
  const start = raw.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function parseModelDetails(text, modelId) {
  const parsed = parseJsonLoose(text);
  if (!parsed) return null;
  const items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [parsed];
  return items.find((item) => item?.id === modelId) || items[0] || null;
}

// Roles containing "audio" belong to audio slots (see audioRoleFromModel); image references never use them.
function referenceRoleFromModel(model, outputKind) {
  const medias = Array.isArray(model?.medias) ? model.medias : [];
  const roles = medias
    .filter((media) => !media?.type || media.type === 'image')
    .flatMap((media) => Array.isArray(media?.roles) ? media.roles : [])
    .filter((role) => typeof role === 'string' && role.trim() && !/audio/i.test(role));
  const preferred = outputKind === 'video'
    ? ['start_image', 'first_frame', 'image', 'reference_image']
    : ['image', 'reference_image', 'input_image', 'subject'];
  return preferred.find((role) => roles.includes(role)) || roles[0] || 'image';
}

// Audio slot of a model: the first media role containing "audio" (a speech reference or a lip-sync track) and, when a
// slot with only audio roles states it, how many tracks it takes. The roles decide, not the slot type: models_explore
// types every slot as "image", also the one that takes audio_references next to image_references. null = the model
// declares no audio input.
function audioSlotFromModel(model) {
  const medias = Array.isArray(model?.medias) ? model.medias : [];
  for (const media of medias) {
    const roles = (Array.isArray(media?.roles) ? media.roles : []).filter((role) => typeof role === 'string' && role.trim());
    const role = roles.find((item) => /audio/i.test(item));
    if (!role) continue;
    const audioOnly = roles.every((item) => /audio/i.test(item));
    return { role, max: audioOnly && Number.isFinite(media.max) && media.max > 0 ? Math.floor(media.max) : null };
  }
  return null;
}

function audioRoleFromModel(model) {
  return audioSlotFromModel(model)?.role || null;
}

// The model record of a models_explore get answer, or null when the answer is not a model (error text, no id).
async function readHiggsfieldModel(modelId) {
  try {
    const details = parseModelDetails(await higgsfield.mcpCall('models_explore', { action: 'get', model_id: modelId }), modelId);
    return details && typeof details.id === 'string' ? details : null;
  } catch (_) {
    return null;
  }
}

// The audio slot to use for a model. A readable model decides (no audio role: null, nothing may be submitted); a model
// that cannot be read at all gets the documented role.
function audioSlotFor(details) {
  return details ? audioSlotFromModel(details) : { role: HIGGSFIELD_AUDIO_REFERENCE_ROLE, max: null };
}

// Media type and MIME type per file extension for the media_upload path.
const HIGGSFIELD_UPLOAD_TYPES = Object.freeze({
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', mime: 'audio/aac' }
});
const HIGGSFIELD_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac']);

// Signed upload URLs are credentials: they must never end up in an error message or a log line.
function redactUrls(text) {
  return String(text || '').replace(/https?:\/\/[^\s"'<>\\)\]]+/gi, '[URL]');
}

// Finds the first object carrying an upload_url in a parsed media_upload answer ({ uploads: [{ ... }] } or similar).
function findUploadRecord(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (!Array.isArray(value) && (typeof value.upload_url === 'string' || typeof value.uploadUrl === 'string')) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findUploadRecord(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// Extracts { uploadUrl, mediaId, contentType } from the text of media_upload. The answer format has NOT been
// verified against the live API, so this accepts JSON, JSON embedded in prose, and finally plain text
// ("upload_url: https://...", a curl command with PUT, or a PUT line).
function parseHiggsfieldUpload(text) {
  const raw = String(text || '');
  const record = findUploadRecord(parseJsonLoose(raw));
  let uploadUrl = record ? String(record.upload_url ?? record.uploadUrl ?? '').trim() : '';
  let mediaId = record ? String(record.media_id ?? record.mediaId ?? record.id ?? '').trim() : '';
  const contentType = record && typeof record.content_type === 'string' ? record.content_type.trim() : '';
  if (!uploadUrl) {
    const labelled = raw.match(/upload_?url["']?\s*[:=]\s*["']?(https:\/\/[^\s"'<>\\]+)/i);
    const curl = raw.match(/\bPUT\b[^\n]*?["']?(https:\/\/[^\s"'<>\\]+)/i);
    // Only an explicitly labelled upload_url or a PUT line counts: a bare URL in prose (a hint, a pricing link) is
    // never taken for the upload target, so a private file is not sent to an unrelated address.
    uploadUrl = (labelled && labelled[1]) || (curl && curl[1]) || '';
  }
  if (!mediaId) {
    const labelled = raw.match(/media_?id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    mediaId = labelled ? labelled[1] : higgsfield.extractJobIds(raw.replace(/https?:\/\/\S+/gi, ' '))[0] || '';
  }
  if (!/^https:\/\//i.test(uploadUrl) || !mediaId) {
    throw new Error(`Higgsfield lieferte keine Upload-URL oder media_id (Antwortformat von media_upload unbekannt): ${shorten(redactUrls(raw), 300)}`);
  }
  return { uploadUrl, mediaId, contentType };
}

// PUTs one file to a presigned upload_url (streamed, Content-Length set: S3 refuses chunked uploads).
async function putHiggsfieldFile(uploadUrl, { filePath, size, contentType }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIGGSFIELD_UPLOAD_TIMEOUT_MS);
  timer.unref?.();
  const body = fs.createReadStream(filePath);
  let response;
  try {
    response = await global.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
      body,
      duplex: 'half',
      signal: controller.signal
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Upload zu Higgsfield hat nach ${Math.round(HIGGSFIELD_UPLOAD_TIMEOUT_MS / 60000)} Minuten das Zeitlimit erreicht.`);
    }
    throw new Error(`Upload zu Higgsfield fehlgeschlagen: ${shorten(redactUrls(err.message), 200)}`);
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
  let detail = '';
  if (!response.ok) {
    // S3 style XML errors carry a short <Code>; the rest of the body may echo parts of the signed request.
    try {
      const code = /<Code>([^<]{1,80})<\/Code>/.exec(await response.text());
      detail = code ? `, ${code[1].replace(/[^A-Za-z0-9_.-]/g, '')}` : '';
    } catch (_) {
      /* no detail */
    }
    throw new Error(`Upload zu Higgsfield fehlgeschlagen (HTTP ${response.status}${detail}).`);
  }
  await response.arrayBuffer().catch(() => {});
}

// Reports a refused media_confirm; the text answer is JSON as far as known (unverified).
function assertHiggsfieldConfirmed(text) {
  const parsed = parseJsonLoose(text);
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const first = Array.isArray(object.results) && object.results[0] && typeof object.results[0] === 'object' ? object.results[0] : {};
  const error = typeof object.error === 'string' && object.error.trim()
    ? object.error
    : /^(failed|error|rejected)$/i.test(String(first.status || '')) ? `Status ${first.status}` : '';
  if (error) throw new Error(`Higgsfield konnte den Upload nicht bestaetigen: ${shorten(redactUrls(error), 200)}`);
}

// Uploads session assets with media_upload -> PUT -> media_confirm; no public server address is needed.
async function uploadHiggsfieldMedia(ctx, ids) {
  const ledger = await store.readLedger(ctx.sessionId);
  const directory = store.sessionAssetDir(ctx.sessionId);
  const mediaIds = [];
  for (const id of ids) {
    const entry = ledger.find((item) => item.id === id);
    if (!entry) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
    if (entry.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
    const storedFile = String(entry.file || '');
    if (!storedFile || path.basename(storedFile) !== storedFile || !/^[A-Za-z0-9._-]+$/.test(storedFile)) {
      throw new Error(`Asset ${id} hat einen ungueltigen Dateinamen.`);
    }
    const ext = path.extname(storedFile).toLowerCase();
    const type = HIGGSFIELD_UPLOAD_TYPES[ext];
    if (!type) throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) kann nicht zu Higgsfield hochgeladen werden.`);
    const filePath = path.join(directory, storedFile);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Asset ${id} konnte nicht gelesen werden: Datei fehlt.`);
      throw new Error(`Asset ${id} konnte nicht gelesen werden: ${err.message}`);
    }
    if (!stat.isFile() || stat.size === 0) throw new Error(`Asset ${id} konnte nicht gelesen werden: keine oder leere Datei.`);
    if (stat.size > MAX_RENDER_ASSET_BYTES) throw new Error(`Asset ${id} ist groesser als 500 MB und kann nicht zu Higgsfield hochgeladen werden.`);

    const created = parseHiggsfieldUpload(
      await higgsfield.mcpCall('media_upload', { filename: `${id}${ext}`, content_type: type.mime })
    );
    // The signature may cover the Content-Type, so send exactly the one Higgsfield answered with.
    await putHiggsfieldFile(created.uploadUrl, { filePath, size: stat.size, contentType: created.contentType || type.mime });
    assertHiggsfieldConfirmed(await higgsfield.mcpCall('media_confirm', { type: type.kind, media_id: created.mediaId }));
    mediaIds.push(created.mediaId);
  }
  return { mediaIds, publishedFiles: [] };
}

// Brings session assets into Higgsfield and returns their media ids. With PUBLIC_BASE_URL the assets are
// published under it and imported by URL; the caller removes the published ref files once the job has been
// submitted (or failed). Without it the bytes are uploaded via media_upload (nothing is published).
async function importHiggsfieldMedia(ctx, ids) {
  if (!String(process.env.PUBLIC_BASE_URL || '').trim()) return uploadHiggsfieldMedia(ctx, ids);
  const publishedFiles = [];
  const mediaIds = [];
  try {
    for (const id of ids) {
      const published = await publicrefs.publishAsset(ctx.sessionId, id);
      publishedFiles.push(published.file);
      const imported = await higgsfield.mcpCall('media_import_url', { url: published.url });
      const mediaId = higgsfield.extractJobIds(imported)[0];
      if (!mediaId) throw new Error(`Higgsfield lieferte fuer Referenz ${id} keine media_id.`);
      mediaIds.push(mediaId);
    }
    return { mediaIds, publishedFiles };
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    throw err;
  }
}

// Reference images (and, for the node view only, audio tracks) of a generation. The audio role and its limit are read
// from the model and checked BEFORE anything is imported or submitted, so a model without an audio slot costs nothing.
// Audio references need at least one image or video reference next to them (a rule of the Higgsfield API).
async function importHiggsfieldReferences(ctx, modelId, outputKind, rawIds, rawAudioIds) {
  const ids = referenceIdArray({ reference_asset_ids: rawIds }, 'reference_asset_ids', 12);
  const audioIds = referenceIdArray({ reference_audio_asset_ids: rawAudioIds }, 'reference_audio_asset_ids', HIGGSFIELD_MAX_AUDIO_REFS);
  if (!ids.length && !audioIds.length) return { medias: [], publishedFiles: [], mediaIds: [] };
  if (audioIds.length && !ids.length) {
    throw new Error('Audio-Referenzen brauchen mindestens eine Bild- oder Video-Referenz (reference_asset_ids). Es wurde nichts eingereicht.');
  }
  if (ids.length) {
    await validateMediaReferenceAssets(
      ctx.sessionId,
      ids,
      new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mp3', '.wav', '.m4a', '.aac']),
      'Higgsfield-Referenz'
    );
  }
  if (audioIds.length) {
    await validateMediaReferenceAssets(ctx.sessionId, audioIds, HIGGSFIELD_AUDIO_EXTS, 'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)');
  }

  // The safe Higgsfield fallback for unclear image roles is "image"; audio uses the documented role only when the
  // model cannot be read at all.
  const details = await readHiggsfieldModel(modelId);
  const role = details ? referenceRoleFromModel(details, outputKind) : 'image';
  let audioSlot = null;
  if (audioIds.length) {
    audioSlot = audioSlotFor(details);
    if (!audioSlot) {
      throw new Error(
        `Das Higgsfield-Modell ${modelId} deklariert keine Audio-Referenz (keine Medien-Rolle mit "audio"). ` +
          'Es wurde nichts eingereicht.'
      );
    }
    if (audioSlot.max !== null && audioIds.length > audioSlot.max) {
      throw new Error(
        `Das Higgsfield-Modell ${modelId} akzeptiert hoechstens ${audioSlot.max} Audio-Referenzen (${audioIds.length} angegeben). ` +
          'Es wurde nichts eingereicht.'
      );
    }
  }

  const { mediaIds, publishedFiles } = await importHiggsfieldMedia(ctx, [...ids, ...audioIds]);
  const medias = [
    ...mediaIds.slice(0, ids.length).map((value) => ({ value, role })),
    ...mediaIds.slice(ids.length).map((value) => ({ value, role: audioSlot.role }))
  ];
  return { medias, publishedFiles, mediaIds };
}

// Model-specific parameters only the node view may pass (args.extra_params). runHiggsfieldGenerate ignores
// them unless ctx.nodeView is set, because the Director's closed tool schema is not enforced server-side.
const HIGGSFIELD_RESERVED_PARAMS = new Set(['model', 'prompt', 'medias', 'use_unlim']);

// Type-checks one extra param against its models_explore definition. Returns { value } or { error }.
function coerceHiggsfieldParam(spec, value) {
  const options = Array.isArray(spec.options) ? spec.options : null;
  const fromOptions = (candidate) => {
    if (!options) return { value: candidate };
    const match = options.find((option) => String(option) === String(candidate));
    return match === undefined ? { error: `Wert ${JSON.stringify(candidate)} ist keine gueltige Option` } : { value: match };
  };
  if (spec.type === 'string') {
    // options like "24000" are strings for the API: a number naming one of them is fine
    const candidate = typeof value === 'number' && options && options.some((option) => String(option) === String(value)) ? String(value) : value;
    if (typeof candidate !== 'string') return { error: 'muss ein String sein' };
    return fromOptions(candidate);
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return { error: spec.type === 'integer' ? 'muss eine ganze Zahl sein' : 'muss eine Zahl sein' };
    if (spec.type === 'integer' && !Number.isInteger(number)) return { error: 'muss eine ganze Zahl sein' };
    if (Number.isFinite(spec.min) && number < spec.min) return { error: `ist kleiner als ${spec.min}` };
    if (Number.isFinite(spec.max) && number > spec.max) return { error: `ist groesser als ${spec.max}` };
    return fromOptions(number);
  }
  if (spec.type === 'bool') {
    if (typeof value === 'boolean') return { value };
    if (value === 'true' || value === 'false') return { value: value === 'true' };
    return { error: 'muss true oder false sein' };
  }
  if (spec.type === 'string_array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return { error: 'muss eine Liste von Strings sein' };
    return { value };
  }
  return { error: `hat den nicht unterstuetzten Typ ${spec.type}` };
}

// Adds the whitelisted extra params to `params` and returns correction notes for dropped ones.
// Every key must exist in the model's parameters[] (models_explore get); unknown, reserved or
// ill-typed keys are dropped. Without a verifiable model nothing is guessed: the call fails before any spend.
async function applyHiggsfieldExtraParams(params, modelId, extra) {
  const corrections = [];
  if (extra === undefined || extra === null) return corrections;
  if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('extra_params muss ein Objekt sein');
  const keys = Object.keys(extra);
  if (!keys.length) return corrections;

  let model = null;
  try {
    model = parseModelDetails(await higgsfield.mcpCall('models_explore', { action: 'get', model_id: modelId }), modelId);
  } catch (_) {
    model = null;
  }
  if (!model || !Array.isArray(model.parameters)) {
    throw new Error(`Higgsfield-Modell ${modelId} konnte nicht geprueft werden - extra_params wurden nicht angewendet.`);
  }
  const schema = new Map(model.parameters.map((spec) => [spec?.name, spec]));
  for (const key of keys) {
    if (HIGGSFIELD_RESERVED_PARAMS.has(key)) {
      corrections.push(`extra_params.${key} ist reserviert und wurde entfernt.`);
      continue;
    }
    const spec = schema.get(key);
    if (!spec) {
      corrections.push(`extra_params.${key} ist fuer ${modelId} nicht definiert und wurde entfernt.`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      corrections.push(`extra_params.${key} ist bereits gesetzt und wurde entfernt.`);
      continue;
    }
    const checked = coerceHiggsfieldParam(spec, extra[key]);
    if (checked.error) {
      corrections.push(`extra_params.${key} ${checked.error} und wurde entfernt.`);
      continue;
    }
    params[key] = checked.value;
  }
  return corrections;
}

// Shared by generation, edit and speech tools: reserves the result asset, submits the MCP call, persists the job
// (the poller completes it) and journals the zero-cost entry. `excludeIds` are UUIDs that can never be the job id
// (e.g. the imported source media of an edit). `kind` is image, video or audio; the poller replaces the reserved
// extension with the one of the downloaded result.
async function submitHiggsfieldJob(ctx, { kind, mcpTool, mcpArgs, prompt, model, mode, publishedFiles = [], excludeIds = [] }) {
  let asset;
  try {
    asset = await store.reserveAsset(ctx.sessionId, {
      kind,
      ext: kind === 'image' ? '.png' : kind === 'audio' ? '.wav' : '.mp4',
      prompt,
      model
    });
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    throw err;
  }

  let submitText;
  try {
    submitText = await higgsfield.mcpCall(mcpTool, mcpArgs);
  } catch (err) {
    await removePublishedRefs(publishedFiles);
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  await removePublishedRefs(publishedFiles);

  const jobId = higgsfield.extractJobIds(submitText).find((id) => !excludeIds.includes(id));
  if (!jobId) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(`Higgsfield lieferte keine Job-ID: ${shorten(submitText, 500)}`);
  }
  // Higgsfield antwortet als TEXT; gelegentlich steht darin die Job-ID des
  // vorherigen Auftrags. Zwei Jobs mit derselben ID wuerden sich gegenseitig
  // ueberschreiben, darum hier abbrechen statt ein Duplikat anzulegen.
  const existingSession = await store.readSession(ctx.sessionId);
  const duplicate = (existingSession.jobs || []).find((entry) => entry.jobId === jobId);
  if (duplicate) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(
      `Higgsfield lieferte die bereits fuer ${duplicate.assetId} verwendete Job-ID ${jobId}. ` +
      'Der Auftrag wurde nicht angelegt - bitte erneut senden.'
    );
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
    mode,
    model,
    user: ctx.user || 'lokal',
    submittedAt,
    createdAt: submittedAt,
    startedAt: null,
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

  ctx.emit({
    type: 'generation_job',
    jobId,
    assetId: asset.id,
    prompt,
    status: job.status,
    source: 'higgsfield',
    provider: 'higgsfield',
    kind,
    ...jobMetaFields(job),
    createdAt: submittedAt,
    startedAt: null
  });
  return { asset, job };
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

  const params = { model, prompt, use_unlim: false };
  if (args.aspect_ratio) params.aspect_ratio = String(args.aspect_ratio);
  if (args.resolution) params.resolution = String(args.resolution);
  // duration and extra_params are checked before any reference is uploaded, so a refused call sends no file to Higgsfield.
  if (kind === 'video' && args.duration !== undefined && args.duration !== null) {
    const duration = Number(args.duration);
    if (!Number.isInteger(duration)) throw new Error('duration muss eine ganze Zahl sein');
    params.duration = duration;
  }
  const corrections = await applyHiggsfieldExtraParams(params, model, ctx.nodeView === true ? args.extra_params : undefined);

  // reference_audio_asset_ids is node view only (like extra_params): the Director's closed schema has no audio slot.
  const refs = await importHiggsfieldReferences(
    ctx,
    model,
    kind,
    args.reference_asset_ids,
    ctx.nodeView === true ? args.reference_audio_asset_ids : undefined
  );
  if (refs.medias.length) params.medias = refs.medias;

  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind,
    mcpTool: kind === 'image' ? 'generate_image_batch' : 'generate_video_batch',
    mcpArgs: { requests: [{ index: 0, params }] },
    prompt,
    model,
    mode: kind === 'image' ? 'higgsfield_image' : 'higgsfield_video',
    publishedFiles: refs.publishedFiles,
    excludeIds: refs.mediaIds
  });
  return {
    toolResult:
      `Higgsfield-${kind === 'image' ? 'Bild' : 'Video'}-Job ${asset.id} gestartet (Job-ID ${job.jobId}, Modell ${model}). ` +
      'Das Ergebnis folgt asynchron. Abrechnung erfolgt in Higgsfield-Credits; den aktuellen Stand zeigt higgsfield_check_balance.' +
      (corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''),
    inject: [],
    job,
    corrections
  };
}

// Higgsfield edit tools of the node view (experimental, not offered to the Director). Each spec lists the media
// kinds of its sources (in order), the kind of its result and build(mediaIds, params, kind), which returns the MCP
// arguments. The sources are imported into Higgsfield first (media_import_url or media_upload) and passed by media id
// under the tool's own field names. The MCP schemas (docs/higgsfield-tools.json) nest all arguments under `params`.
// The first five pass their params through; the newer ones check every value against the schema enums and drop
// unknown keys (their schemas have additionalProperties: false).
const HIGGSFIELD_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const HIGGSFIELD_VIDEO_EXTS = new Set(['.mp4', '.webm']);
const HIGGSFIELD_DUBBING_LANGUAGES = Object.freeze([
  'eng', 'cmn', 'fra', 'hin', 'ita', 'jpn', 'kor', 'por', 'rus', 'tur', 'spa', 'deu', 'ara', 'pol', 'ind', 'fil', 'swe', 'fin'
]);
const HIGGSFIELD_VOICE_TYPES = Object.freeze(['preset', 'element']);
const HIGGSFIELD_MOTION_RESOLUTIONS = Object.freeze(['720p', '1080p']);
const HIGGSFIELD_SCENE_CONTROLS = Object.freeze(['image', 'video']);

// A value of a fixed set: missing/blank falls back to `fallback` (undefined = required).
function higgsfieldEnum(params, key, allowed, fallback) {
  const raw = params[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (fallback === undefined) throw new Error(`${key} fehlt (erlaubt: ${allowed.join(', ')})`);
    return fallback;
  }
  const value = String(raw).trim();
  if (!allowed.includes(value)) throw new Error(`${key} "${shorten(value, 40)}" ist ungueltig (erlaubt: ${allowed.join(', ')})`);
  return value;
}

const HIGGSFIELD_EDIT_TOOLS = Object.freeze({
  remove_background: {
    sources: (kind) => [kind],
    output: (kind) => kind,
    build: ([mediaId], params, kind) => ({ ...params, media_id: mediaId, media_type: kind })
  },
  upscale_image: {
    sources: () => ['image'],
    output: () => 'image',
    build: ([mediaId], params) => ({ ...params, image_id: mediaId })
  },
  upscale_video: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => ({ ...params, video_id: mediaId })
  },
  outpaint_image: {
    sources: () => ['image'],
    output: () => 'image',
    build: ([mediaId], params) => ({ ...params, image_id: mediaId })
  },
  reframe: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => ({ ...params, medias: [{ value: mediaId, role: 'video' }] })
  },
  dubbing: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => ({
      video_id: mediaId,
      target_language: higgsfieldEnum(params, 'target_language', HIGGSFIELD_DUBBING_LANGUAGES)
    })
  },
  voice_change: {
    sources: () => ['video'],
    output: () => 'video',
    build: ([mediaId], params) => {
      const voiceId = String(params.voice_id ?? '').trim();
      if (!voiceId) throw new Error('voice_id fehlt');
      return {
        video_id: mediaId,
        voice_id: voiceId,
        voice_type: higgsfieldEnum(params, 'voice_type', HIGGSFIELD_VOICE_TYPES, 'preset')
      };
    }
  },
  motion_control: {
    sources: () => ['image', 'video'],
    output: () => 'video',
    build: ([imageId, motionVideoId], params) => ({
      image_id: imageId,
      motion_video_id: motionVideoId,
      resolution: higgsfieldEnum(params, 'resolution', HIGGSFIELD_MOTION_RESOLUTIONS, '720p'),
      scene_control: higgsfieldEnum(params, 'scene_control', HIGGSFIELD_SCENE_CONTROLS, 'image')
    })
  }
});

async function runHiggsfieldEdit(ctx, args) {
  requireHiggsfieldConnection();
  const tool = String(args.tool || '').trim();
  const spec = Object.prototype.hasOwnProperty.call(HIGGSFIELD_EDIT_TOOLS, tool) ? HIGGSFIELD_EDIT_TOOLS[tool] : null;
  if (!spec) throw new Error(`Unbekanntes Higgsfield-Edit-Tool: ${tool || '(leer)'}`);
  const kind = args.kind === 'video' ? 'video' : args.kind === 'image' ? 'image' : null;
  if (!kind) throw new Error('kind muss image oder video sein');
  const sourceKinds = spec.sources(kind);
  const outputKind = spec.output(kind);
  const ids = Array.isArray(args.source_asset_ids) ? args.source_asset_ids.map((id) => String(id || '').trim()) : [];
  if (ids.length !== sourceKinds.length || ids.some((id) => !id)) {
    throw new Error(
      sourceKinds.length === 1
        ? 'source_asset_ids muss genau eine Asset-ID enthalten'
        : `source_asset_ids muss genau ${sourceKinds.length} Asset-IDs enthalten (${sourceKinds.map((item) => (item === 'video' ? 'Video' : 'Bild')).join(', ')})`
    );
  }
  for (let index = 0; index < ids.length; index += 1) {
    const video = sourceKinds[index] === 'video';
    await validateMediaReferenceAssets(ctx.sessionId, [ids[index]], video ? HIGGSFIELD_VIDEO_EXTS : HIGGSFIELD_IMAGE_EXTS, video ? 'Video-Quelle' : 'Bild-Quelle');
  }
  const toolParams = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
  // Dry run with placeholder ids: bad params fail here, before anything is uploaded or imported.
  spec.build(ids.map(() => '00000000-0000-0000-0000-000000000000'), toolParams, kind);
  ctx.emit({ type: 'tool_start', tool: 'higgsfield_edit', label: `Starte Higgsfield ${tool}: ${ids.join(' + ')}` });

  const imported = await importHiggsfieldMedia(ctx, ids);
  let mcpParams;
  try {
    mcpParams = spec.build(imported.mediaIds, toolParams, kind);
  } catch (err) {
    await removePublishedRefs(imported.publishedFiles);
    throw err;
  }
  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind: outputKind,
    mcpTool: tool,
    mcpArgs: { params: mcpParams },
    prompt: `Higgsfield ${tool}: ${ids.join(' + ')}`,
    model: tool,
    mode: 'higgsfield_edit',
    publishedFiles: imported.publishedFiles,
    excludeIds: imported.mediaIds
  });
  return {
    toolResult: `Higgsfield-${tool}-Job ${asset.id} gestartet (Job-ID ${job.jobId}). Das Ergebnis folgt asynchron.`,
    inject: [],
    job
  };
}

// Speech output of the node view (generate_audio_batch with one request) with seed_audio or text2speech_v2.
// The voice is a preset or a workspace element; seed_audio also takes up to two reference audios, passed under the
// audio role the model declares (models_explore get; audio_references when the model cannot be read at all).
// Everything that can be wrong is checked before anything is imported or submitted, so a bad call costs nothing.
async function runHiggsfieldSpeech(ctx, args) {
  requireHiggsfieldConnection();
  const model = String(args.model || '').trim() || HIGGSFIELD_DEFAULT_AUDIO_MODEL;
  if (!HIGGSFIELD_SPEECH_MODELS.includes(model)) {
    throw new Error(`Das Modell ${shorten(model, 60)} ist fuer die Sprachausgabe nicht vorgesehen (erlaubt: ${HIGGSFIELD_SPEECH_MODELS.join(', ')})`);
  }
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt fehlt');
  const voiceId = String(args.voice_id ?? '').trim();
  // voice_type and voice_id only work as a pair
  if (!voiceId && String(args.voice_type ?? '').trim()) throw new Error('voice_type und voice_id gehoeren zusammen: voice_id fehlt');
  const voiceType = higgsfieldEnum(args, 'voice_type', HIGGSFIELD_VOICE_TYPES, 'preset');
  const audioIds = referenceIdArray(args, 'reference_audio_asset_ids', 50);
  if (audioIds.length > HIGGSFIELD_MAX_SPEECH_REFS) {
    throw new Error(`Die Sprachausgabe akzeptiert hoechstens ${HIGGSFIELD_MAX_SPEECH_REFS} Referenz-Audiodateien (${audioIds.length} angegeben)`);
  }
  if (model === 'text2speech_v2') {
    if (audioIds.length) throw new Error('text2speech_v2 nimmt keine Referenz-Audiodatei (nur seed_audio)');
    if (!voiceId) throw new Error('voice_id fehlt (text2speech_v2 braucht eine Stimme)');
  } else if (!voiceId && !audioIds.length) {
    throw new Error('voice_id fehlt (oder eine Referenz-Audiodatei angeben)');
  }

  // extra_params (node view only): the voice comes from the voice fields alone, and only formats the app can store pass.
  const corrections = [];
  const extraInput = ctx.nodeView === true ? args.extra_params : undefined;
  const extra = extraInput && typeof extraInput === 'object' && !Array.isArray(extraInput) ? { ...extraInput } : extraInput;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const key of ['voice_id', 'voice_type']) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        delete extra[key];
        corrections.push(`extra_params.${key} ist fuer die Sprachausgabe reserviert (Stimme separat waehlen) und wurde entfernt.`);
      }
    }
    if (extra.format !== undefined && !HIGGSFIELD_SPEECH_FORMATS.includes(extra.format)) {
      throw new Error(
        `Das Audioformat "${shorten(String(extra.format), 20)}" wird von der App nicht unterstuetzt ` +
          `(erlaubt: ${HIGGSFIELD_SPEECH_FORMATS.join(', ')}; pcm und ogg_opus lassen sich nicht abspielen). Es wurde nichts eingereicht.`
      );
    }
  }
  const variantError = `variant fehlt oder ist ungueltig (text2speech_v2 braucht eine dieser Varianten: ${HIGGSFIELD_SPEECH_VARIANTS.join(', ')})`;
  if (model === 'text2speech_v2' && !HIGGSFIELD_SPEECH_VARIANTS.includes(extra?.variant)) throw new Error(variantError);

  let audioRole = null;
  if (audioIds.length) {
    await validateMediaReferenceAssets(ctx.sessionId, audioIds, HIGGSFIELD_AUDIO_EXTS, 'Audio-Referenz (erlaubt: MP3, WAV, M4A oder AAC)');
    const slot = audioSlotFor(await readHiggsfieldModel(model));
    if (!slot) {
      throw new Error(`Das Higgsfield-Modell ${model} deklariert keine Audio-Referenz (keine Medien-Rolle mit "audio"). Es wurde nichts eingereicht.`);
    }
    if (slot.max !== null && audioIds.length > slot.max) {
      throw new Error(`Das Higgsfield-Modell ${model} akzeptiert hoechstens ${slot.max} Audio-Referenzen (${audioIds.length} angegeben). Es wurde nichts eingereicht.`);
    }
    audioRole = slot.role;
  }
  ctx.emit({ type: 'tool_start', tool: 'higgsfield_speech', label: `Starte Higgsfield-Sprachausgabe: ${shorten(prompt, 80)}` });

  const imported = audioIds.length ? await importHiggsfieldMedia(ctx, audioIds) : { mediaIds: [], publishedFiles: [] };
  const params = { model, prompt, use_unlim: false };
  if (voiceId) {
    params.voice_type = voiceType;
    params.voice_id = voiceId;
  }
  if (imported.mediaIds.length) params.medias = imported.mediaIds.map((value) => ({ value, role: audioRole }));
  try {
    corrections.push(...await applyHiggsfieldExtraParams(params, model, extra));
    // the extra param may have been dropped (not defined for the model): never submit without the variant
    if (model === 'text2speech_v2' && !HIGGSFIELD_SPEECH_VARIANTS.includes(params.variant)) throw new Error(`${variantError}. Es wurde nichts eingereicht.`);
  } catch (err) {
    await removePublishedRefs(imported.publishedFiles);
    throw err;
  }

  const { asset, job } = await submitHiggsfieldJob(ctx, {
    kind: 'audio',
    mcpTool: 'generate_audio_batch',
    mcpArgs: { requests: [{ index: 0, params }] },
    prompt,
    model,
    mode: 'higgsfield_audio',
    publishedFiles: imported.publishedFiles,
    excludeIds: imported.mediaIds
  });
  return {
    toolResult:
      `Higgsfield-Audio-Job ${asset.id} gestartet (Job-ID ${job.jobId}, Modell ${model}). Das Ergebnis folgt asynchron.` +
      (corrections.length ? ` Hinweis: ${corrections.join(' ')}` : ''),
    inject: [],
    job,
    corrections
  };
}

// Strings of a JSON value that equal the placeholder (any depth).
function countFalPlaceholder(node, placeholder) {
  if (typeof node === 'string') return node === placeholder ? 1 : 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countFalPlaceholder(item, placeholder), 0);
  if (node && typeof node === 'object') return Object.values(node).reduce((sum, item) => sum + countFalPlaceholder(item, placeholder), 0);
  return 0;
}

function replaceFalPlaceholders(node, replacements) {
  if (typeof node === 'string') return replacements.has(node) ? replacements.get(node) : node;
  if (Array.isArray(node)) return node.map((item) => replaceFalPlaceholders(item, replacements));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, replaceFalPlaceholders(value, replacements)]));
  }
  return node;
}

function falPricing(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pricing muss ein Objekt sein');
  const perSecond = Number(raw.perSecond);
  if (!Number.isFinite(perSecond) || perSecond <= 0 || perSecond > 100) throw new Error('pricing.perSecond muss eine Zahl zwischen 0 und 100 sein');
  const pricing = { perSecond };
  if (raw.overSeconds !== undefined && raw.overSeconds !== null) {
    const overSeconds = Number(raw.overSeconds);
    const overMultiplier = Number(raw.overMultiplier);
    if (!Number.isFinite(overSeconds) || overSeconds <= 0 || !Number.isFinite(overMultiplier) || overMultiplier < 1 || overMultiplier > 10) {
      throw new Error('pricing.overSeconds und pricing.overMultiplier sind ungueltig');
    }
    pricing.overSeconds = overSeconds;
    pricing.overMultiplier = overMultiplier;
  }
  // Result field that carries the billed seconds; null = the result says nothing reliable, the estimate is used.
  if (raw.durationField === null) pricing.durationField = null;
  else if (raw.durationField === undefined) pricing.durationField = 'duration';
  else if (typeof raw.durationField === 'string' && /^[a-z][a-z_]{0,31}$/.test(raw.durationField)) pricing.durationField = raw.durationField;
  else throw new Error('pricing.durationField ist ungueltig');
  return pricing;
}

// Node view only. Uploads the referenced session assets to the fal storage, queues one job at fal.ai and registers it
// in the session; the poller (lib/poller.js) fetches the result. Nothing is uploaded or submitted unless every check
// passes. `input` is the model input without the media fields; `media` entries say which field receives which asset URLs.
async function runFalGenerate(ctx, args) {
  const signal = ctx.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw fal.abortError();
  };
  throwIfAborted();
  if (!fal.hasKey()) throw new Error(fal.MISSING_KEY_MESSAGE);
  const endpoint = String(args.endpoint || '').trim();
  if (!fal.isValidEndpointId(endpoint)) throw new Error(`Ungueltige fal.ai-Endpoint-ID: ${shorten(endpoint || '(leer)', 80)}`);
  const kind = args.kind === undefined || args.kind === null ? 'video' : String(args.kind);
  if (!FAL_KINDS.includes(kind)) throw new Error(`kind muss ${FAL_KINDS.join(', ')} sein`);
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) throw new Error('input muss ein Objekt sein');
  let input;
  try {
    const text = JSON.stringify(args.input);
    if (text.length > FAL_MAX_INPUT_BYTES) throw new Error('zu gross');
    input = JSON.parse(text);
  } catch (_) {
    throw new Error('input ist kein gueltiges JSON-Objekt oder groesser als 1 MB');
  }
  let estimateUsd = null;
  if (args.estimateUsd !== undefined && args.estimateUsd !== null) {
    estimateUsd = Number(args.estimateUsd);
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > 10000) throw new Error('estimateUsd ist ungueltig');
  }
  const pricing = falPricing(args.pricing);
  const prompt = shorten(typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt : `fal.ai ${endpoint}`, 500);

  // media entries: { field, assetIds, multiple } fill a top-level field of the input; { placeholder, assetIds, multiple }
  // replaces every string of the input (at any depth) that equals the placeholder (free-form fal nodes).
  const rawMedia = args.media === undefined || args.media === null ? [] : args.media;
  if (!Array.isArray(rawMedia)) throw new Error('media muss ein Array sein');
  const names = new Set();
  const plan = [];
  let fileCount = 0;
  for (const entry of rawMedia) {
    const field = entry?.field === undefined || entry?.field === null ? '' : String(entry.field).trim();
    const placeholder = entry?.placeholder === undefined || entry?.placeholder === null ? '' : String(entry.placeholder);
    if (Boolean(field) === Boolean(placeholder)) throw new Error('media: genau eines von field oder placeholder angeben');
    if (field && !/^[a-z][a-z0-9_]{0,63}$/.test(field)) throw new Error(`Ungueltiger media-Feldname: ${shorten(field, 40)}`);
    if (placeholder && !/^@@[A-Za-z0-9_:.-]{1,60}@@$/.test(placeholder)) throw new Error(`Ungueltiger media-Platzhalter: ${shorten(placeholder, 40)}`);
    const name = field || placeholder;
    if (names.has(name) || (field && Object.prototype.hasOwnProperty.call(input, field))) throw new Error(`Das Feld ${name} ist doppelt belegt`);
    names.add(name);
    const ids = Array.isArray(entry.assetIds) ? entry.assetIds.map((id) => String(id || '').trim()) : [];
    if (!ids.length || ids.some((id) => !id)) throw new Error(`media.${name}: assetIds fehlt`);
    if (entry.multiple !== true && ids.length > 1) throw new Error(`media.${name}: nur eine Datei erlaubt (${ids.length} angegeben)`);
    fileCount += ids.length;
    plan.push({ field, placeholder, name, ids, multiple: entry.multiple === true });
  }
  if (plan.some((item) => item.placeholder) && !plan.every((item) => !item.placeholder || countFalPlaceholder(input, item.placeholder) > 0)) {
    throw new Error('Ein media-Platzhalter kommt in der Eingabe nicht vor');
  }
  if (fileCount > FAL_MAX_MEDIA_FILES) throw new Error(`Hoechstens ${FAL_MAX_MEDIA_FILES} Dateien pro fal.ai-Job (${fileCount} angegeben)`);

  // Every asset must exist in THIS session, be finished, have a known media type and fit the upload cap.
  const ledger = await store.readLedger(ctx.sessionId);
  const dir = store.sessionAssetDir(ctx.sessionId);
  const uploads = [];
  for (const item of plan) {
    for (const id of item.ids) {
      const asset = ledger.find((entry) => entry.id === id);
      if (!asset) throw new Error(`Asset ${id} existiert nicht in dieser Session.`);
      if (asset.pending) throw new Error(`Asset ${id} ist noch nicht fertig.`);
      const file = String(asset.file || '');
      const ext = path.extname(file).toLowerCase();
      if (!file || path.basename(file) !== file || !Object.prototype.hasOwnProperty.call(FAL_UPLOAD_MIME, ext)) {
        throw new Error(`Asset ${id} (${ext || 'ohne Endung'}) kann nicht zu fal.ai hochgeladen werden (erlaubt: Bild, Video oder Audio).`);
      }
      let stat;
      try {
        stat = await fsp.stat(path.join(dir, file));
      } catch (_) {
        throw new Error(`Die Datei von Asset ${id} fehlt.`);
      }
      if (stat.size > fal.MAX_UPLOAD_BYTES) {
        throw new Error(`Asset ${id} ist groesser als ${fal.MAX_UPLOAD_BYTES / (1024 * 1024)} MB und kann nicht zu fal.ai hochgeladen werden.`);
      }
      uploads.push({ name: item.name, id, file, contentType: FAL_UPLOAD_MIME[ext] });
    }
  }
  ctx.emit({ type: 'tool_start', tool: 'fal_generate', label: `Starte fal.ai ${endpoint}: ${shorten(prompt, 80)}` });

  // Uploads run one after the other; each URL lands in its field (a list for `multiple`).
  const urlsByName = new Map(plan.map((item) => [item.name, []]));
  const urlByAsset = new Map(); // an asset referenced twice is uploaded once
  for (const upload of uploads) {
    throwIfAborted();
    if (!urlByAsset.has(upload.id)) {
      const uploaded = await fal.uploadFile(path.join(dir, upload.file), { contentType: upload.contentType, fileName: upload.file, signal });
      urlByAsset.set(upload.id, uploaded.url);
    }
    urlsByName.get(upload.name).push(urlByAsset.get(upload.id));
  }
  const replacements = new Map();
  for (const item of plan) {
    const value = item.multiple ? urlsByName.get(item.name) : urlsByName.get(item.name)[0];
    if (item.field) input[item.field] = value;
    else replacements.set(item.placeholder, value);
  }
  if (replacements.size) input = replaceFalPlaceholders(input, replacements);

  // Last chance to stop before the job is queued (and billed) at fal.ai.
  throwIfAborted();
  const assetKind = kind === 'auto' ? 'video' : kind;
  const asset = await store.reserveAsset(ctx.sessionId, {
    kind: assetKind,
    ext: assetKind === 'image' ? '.png' : assetKind === 'audio' ? '.mp3' : '.mp4',
    prompt,
    model: endpoint
  });
  let submitted;
  try {
    submitted = await fal.submit(endpoint, input);
  } catch (err) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw err;
  }
  // The same request id twice would let two jobs overwrite each other: stop instead of creating a duplicate.
  const existingSession = await store.readSession(ctx.sessionId);
  const duplicate = (existingSession.jobs || []).find((entry) => entry.jobId === submitted.requestId);
  if (duplicate) {
    await removeReservedAsset(ctx.sessionId, asset.id);
    throw new Error(
      `fal.ai lieferte die bereits fuer ${duplicate.assetId} verwendete Job-ID. Der Auftrag wurde nicht angelegt - bitte erneut senden.`
    );
  }
  const submittedAt = new Date().toISOString();
  const job = {
    jobId: submitted.requestId,
    provider: 'fal',
    source: 'fal',
    kind: assetKind,
    resultKind: kind,
    assetId: asset.id,
    file: asset.file,
    status: 'pending',
    prompt,
    mode: 'fal_generate',
    model: endpoint,
    endpoint,
    statusUrl: submitted.statusUrl,
    responseUrl: submitted.responseUrl,
    user: ctx.user || 'lokal',
    submittedAt,
    createdAt: submittedAt,
    startedAt: null,
    timeoutAt: Date.now() + FAL_JOB_TIMEOUT_MS,
    costEstimateUsd: estimateUsd,
    pricing,
    keepResult: args.keepResult === true,
    cost: null,
    costUnit: 'usd_estimate',
    error: null,
    ...budgetFieldsOf(ctx)
  };
  await store.mutateSession(ctx.sessionId, (session) => session.jobs.push(job));
  ctx.emit({
    type: 'generation_job',
    jobId: job.jobId,
    assetId: asset.id,
    prompt,
    status: job.status,
    source: 'fal',
    provider: 'fal',
    kind: assetKind,
    ...jobMetaFields(job),
    createdAt: submittedAt,
    startedAt: null
  });
  return {
    toolResult: `fal.ai-Job ${asset.id} gestartet (${endpoint}). Das Ergebnis folgt asynchron.`,
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

async function runSaveMemory(ctx, args) {
  const note = String(args.note || '').trim();
  if (!note) throw new Error('note fehlt');
  // User management: the global memory is kept per person, so a private chat never feeds somebody else's prompt.
  const viewer = viewerOfCtx(ctx);
  await store.appendBrainMemory(note, { owner: viewer.active ? viewer.email : null });
  return { toolResult: 'Gemerkt.', inject: [] };
}

async function runSaveProjectMemory(ctx, args) {
  const session = await store.readSession(ctx.sessionId);
  const folder = typeof session.folder === 'string' ? session.folder.trim() : '';
  if (!folder) {
    throw new Error('Dieser Chat gehoert zu keinem Projekt - Projekt-Memory braucht ein Projekt. Fuer globale Learnings save_memory verwenden.');
  }
  // User management: the note remembers the chat it came from and is only shown to people who may use that chat.
  const viewer = viewerOfCtx(ctx);
  const entry = await store.addFolderMemory(folder, args?.note, viewer.active ? { owner: viewer.email, sessionId: ctx.sessionId } : {});
  const profile = await store.visibleFolderProfile(await store.readFolderProfile(folder), viewer);
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
  concat_videos: runConcatVideos,
  higgsfield_models: runHiggsfieldModels,
  higgsfield_generate_image: runHiggsfieldGenerateImage,
  higgsfield_generate_video: runHiggsfieldGenerateVideo,
  // Node view only: deliberately not part of toolDefinitions(); executeTool rejects them without ctx.nodeView.
  higgsfield_edit: runHiggsfieldEdit,
  higgsfield_speech: runHiggsfieldSpeech,
  fal_generate: runFalGenerate,
  generate_music: runGenerateMusic,
  plan_music: runPlanMusic,
  higgsfield_check_balance: runHiggsfieldCheckBalance,
  save_memory: runSaveMemory,
  save_project_memory: runSaveProjectMemory
};

// Tools only the node view may run (the engine sets ctx.nodeView). The Director must never reach them,
// even if a model invents a call: the tool schema alone is not enforced server-side.
const NODE_ONLY_TOOLS = new Set(['higgsfield_edit', 'higgsfield_speech', 'fal_generate', 'generate_music', 'plan_music']);

// Restrictions of participants and guests (throws a RoleRestrictedError).
function enforceRoleLimits(name) {
  if (HIGGSFIELD_TOOL_NAMES.has(name)) {
    throw new access.RoleRestrictedError('higgsfield', 'Higgsfield is not available for your account', 'Higgsfield ist für dein Konto nicht verfügbar.');
  }
  const feature = INTERNAL_RESOURCE_TOOLS[name];
  if (feature) {
    throw new access.RoleRestrictedError(
      feature,
      `${name} uses internal resources that are not available for your account`,
      `${name} nutzt interne Ressourcen, die für dein Konto nicht verfügbar sind.`
    );
  }
}

// ElevenLabs bills per character. The list price depends on the plan, so participants are charged a conservative
// estimate (ELEVENLABS_USD_PER_1K_CHARS, default 0.30) that is reserved before the call and booked afterwards.
const SPEECH_MAX_CHARS = 2500;
function speechUsdPerChar() {
  const perThousand = Number(process.env.ELEVENLABS_USD_PER_1K_CHARS);
  return (Number.isFinite(perThousand) && perThousand > 0 ? perThousand : 0.3) / 1000;
}
function speechEstimateUsd(text) {
  const chars = Math.min([...String(text || '').trim()].length, SPEECH_MAX_CHARS);
  return chars > 0 ? Math.round(chars * speechUsdPerChar() * 1e6) / 1e6 : null;
}

// Music is billed by the minute (the API list price is 0.15 USD; the default leaves some room). The estimate is booked
// for everybody, like the speech, and reserved for participants before the call.
const MUSIC_DEFAULT_USD_PER_MIN = 0.2;
function musicUsdPerMinute() {
  const perMinute = Number(process.env.ELEVENLABS_MUSIC_USD_PER_MIN);
  return Number.isFinite(perMinute) && perMinute > 0 ? perMinute : MUSIC_DEFAULT_USD_PER_MIN;
}
function musicEstimateUsd(lengthMs) {
  return Number.isFinite(lengthMs) && lengthMs > 0 ? Math.round((lengthMs / 60000) * musicUsdPerMinute() * 1e6) / 1e6 : null;
}

function toolEstimateUsd(name, args, ctx = null) {
  if (name === 'generate_speech') return speechEstimateUsd(args?.text);
  if (name === 'generate_music') {
    try {
      return musicEstimateUsd(musicRequest(args).lengthMs);
    } catch (_) {
      return null; // the call itself refuses what is wrong
    }
  }
  // A video whose model is known (chosen on the card or remembered for the chat) reserves its estimated price.
  if (name === 'generate_video') return Number.isFinite(ctx?.videoEstimateUsd) && ctx.videoEstimateUsd >= 0 ? ctx.videoEstimateUsd : null;
  if (name !== 'fal_generate' || args?.estimateUsd === undefined || args?.estimateUsd === null) return null;
  const estimate = Number(args.estimateUsd);
  return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
}

// The chat asks for the video model before a paid job (lib/video-models.js). Decides for this call: show the card
// ('card'), start with the model this person remembered for the chat ('direct'), or - with the switch off or outside the chat - the old
// way with the configured model (no plan). Returns the context the executor and the budget see.
async function withVideoPlan(ctx, args, viewer) {
  if (!ctx || ctx.selectedVideoModel === true) return { ctx, args };
  // Without the picker (outside the chat, or the admin switch is off) the model and its limits stay as they were.
  if (ctx.pickVideoModel !== true || !settings.getPreference('askVideoModel')) return { ctx: { ...ctx, skipVideoModelLimits: true }, args };
  const budgetStatus = access.isRestricted(viewer) ? await budget.status(viewer) : null;
  const plan = await videoModels.plan({ sessionId: ctx.sessionId, args, defaultModel: ctx.config.videoModel, budgetStatus, viewer });
  if (plan.kind === 'direct') {
    return {
      ctx: {
        ...ctx,
        config: { ...ctx.config, videoModel: plan.option.id },
        videoPlan: plan,
        videoOption: plan.option,
        videoEstimateUsd: plan.option.estimateUsd
      },
      // The job gets the duration and resolution its estimate was calculated for.
      args: { ...args, duration_seconds: plan.option.durationSeconds, resolution: plan.option.resolution }
    };
  }
  return { ctx: { ...ctx, videoPlan: plan }, args };
}

async function executeTool(ctx, name, args) {
  const executor = Object.prototype.hasOwnProperty.call(EXECUTORS, name) ? EXECUTORS[name] : null;
  if (!executor) throw new Error(`Unbekanntes Tool: ${name}`);
  if (NODE_ONLY_TOOLS.has(name) && !(ctx && ctx.nodeView === true)) throw new Error(`Tool ${name} ist nur in der Node-Ansicht verfuegbar`);
  const viewer = viewerOfCtx(ctx);
  if (name === 'generate_video') ({ ctx, args } = await withVideoPlan(ctx, args, viewer));
  if (!access.isRestricted(viewer)) return executor(ctx, args);
  enforceRoleLimits(name);
  // A participant's paid call needs budget left; where the price is known it must fit. The grant reserves the estimate
  // while the call runs. Async jobs keep it (the job carries the key), everything else releases it right away.
  const grant = PAID_TOOLS.has(name)
    ? await budget.begin(viewer, {
      estimateUsd: toolEstimateUsd(name, args, ctx),
      runKey: ctx?.budgetKey || null,
      label: name,
      asyncJob: ASYNC_PAID_TOOLS.has(name)
    })
    : budget.NOOP_GRANT;
  let outcome;
  try {
    outcome = await executor(grant.applies ? { ...ctx, budgetGrant: grant } : ctx, args);
  } catch (err) {
    grant.release();
    throw err;
  }
  if (!outcome || !outcome.job) grant.release();
  return outcome;
}

module.exports = {
  toolDefinitions,
  executeTool,
  shorten,
  buildVideoPayload,
  renderAssetsFromIds,
  validateConcatArgs,
  concatStrategy: ffmpeg.concatStrategy,
  MAX_RENDER_ASSET_BYTES,
  // Used by the node view (lib/nodes) so it never duplicates limits or tool descriptions.
  storeImportedSessionAsset,
  parseJsonLoose,
  RENDER_MOTION_GRAPHICS_DEFINITION,
  libraryVoices,
  musicEstimateUsd,
  speechEstimateUsd,
  toolEstimateUsd,
  IMAGE_RATIOS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  MAX_RENDER_ASSETS,
  MAX_CONCAT_ASSETS,
  RENDER_FORMATS,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_MODEL_ID,
  HIGGSFIELD_DEFAULT_AUDIO_MODEL,
  HIGGSFIELD_SPEECH_MODELS,
  HIGGSFIELD_SPEECH_FORMATS,
  HIGGSFIELD_SPEECH_VARIANTS,
  HIGGSFIELD_MAX_SPEECH_REFS,
  HIGGSFIELD_MAX_AUDIO_REFS,
  HIGGSFIELD_AUDIO_REFERENCE_ROLE,
  HIGGSFIELD_DUBBING_LANGUAGES,
  HIGGSFIELD_VOICE_TYPES,
  HIGGSFIELD_MOTION_RESOLUTIONS,
  HIGGSFIELD_SCENE_CONTROLS,
  FAL_MAX_MEDIA_FILES,
  FAL_UPLOAD_MIME,
  audioRoleFromModel,
  audioSlotFromModel,
  parseHiggsfieldUpload
};
