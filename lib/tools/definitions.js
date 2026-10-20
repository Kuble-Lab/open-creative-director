'use strict';

// Tool schemas and availability, moved from lib/tools.js.

const access = require('../access');
const rendernode = require('../rendernode');
const ffmpeg = require('../ffmpeg');
const higgsfield = require('../higgsfield');
const {
  IMAGE_RATIOS,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  DEFAULT_ELEVENLABS_VOICE_ID,
  DEFAULT_ELEVENLABS_MODEL_ID,
  WORKFLOW_LANGUAGES,
  MAX_RENDER_ASSETS,
  MAX_CONCAT_ASSETS
} = require('./shared');

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
  speaker: {
    anyOf: [
      {
        type: 'object',
        properties: {
          voiceId: { type: 'string', description: 'ElevenLabs voice ID (see list_voices).' },
          name: { type: 'string', description: 'Name of the voice, for display.' }
        },
        required: ['voiceId'],
        additionalProperties: false
      },
      { type: 'null' }
    ],
    description: 'The speaker voice of the brand (an ElevenLabs voice that the speech nodes take from the branding). null removes it.'
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
            description: `ElevenLabs model ID. Defaults to ${DEFAULT_ELEVENLABS_MODEL_ID}; eleven_v4_turbo is faster and costs half.`
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
  },
  {
    type: 'function',
    function: {
      name: 'list_workflows',
      description:
        'List the workflow templates and the workflows this user may start (their own and those shared with them): per entry the id, a short description, the inputs with their type and whether they are required, the outputs and whether the run has paid steps. Call it before run_workflow to find the template_id or workflow_id and the exact input names. Never name prices: the app shows them on the card.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 80, description: 'Optional search words for the name or description.' },
          language: { type: 'string', enum: WORKFLOW_LANGUAGES, description: 'Language of the template names: the language you speak with the user. Default de.' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_workflow',
      description:
        'Prepare a run of a workflow template or workflow: the text and the chat assets you pass go into its inputs, then the app shows the user a card with the inputs, the steps and the estimated cost. A template becomes a new workflow in the user\'s workflow list. A run without paid steps starts at once and its result appears in the chat by itself. A run with paid steps waits for the user\'s click on the card and ends your turn: say in one short sentence BEFORE the call that the card appears below, do not call this tool again while the card waits, do not ask in text whether to start, and never name amounts (the card shows them). Fill the inputs from what the user said; ask only when a required input is missing. Media come from THIS chat as asset ids (never invent ids).',
      parameters: {
        type: 'object',
        properties: {
          template_id: { type: 'string', maxLength: 120, description: 'Id of a template from list_workflows. Give either template_id or workflow_id.' },
          workflow_id: { type: 'string', maxLength: 120, description: 'Id of a workflow from list_workflows (own or shared with the user). Give either template_id or workflow_id.' },
          inputs: {
            type: 'object',
            description:
              'Values of the inputs: the key is the input name or id from list_workflows, the value a text, a number, true/false, one of the options, or for media the asset id of this chat (a list of asset ids for an input that takes several files). A language input has the choice "auto": the text is then written in the language of the topic, brief or document of the person (leave it unless another language is wanted).',
            additionalProperties: true
          },
          name: { type: 'string', maxLength: 120, description: 'Optional name of the new workflow (templates only). Default: the name of the template.' },
          language: { type: 'string', enum: WORKFLOW_LANGUAGES, description: 'Language of the template: the language you speak with the user. Default de.' }
        },
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

// Higgsfield uses access.higgsfieldAllowed; GTS and brandings remain internal resources.
// executeTool enforces the same restrictions; here the tools just are not offered.
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
const PAID_TOOLS = new Set(['generate_image', 'edit_image', 'generate_video', 'generate_speech', 'generate_speech_timed', 'generate_music', 'lyrics_timing', 'fal_generate', 'edit_video_openrouter', 'higgsfield_generate_image', 'higgsfield_generate_video', 'higgsfield_edit', 'higgsfield_speech']);

// Paid tools that start a provider job booked only when it is done (the poller). Their grant keeps a reservation with the
// job (a flat one where the price is unknown) and a person may have only a few open at once (lib/budget.js).
const ASYNC_PAID_TOOLS = new Set(['generate_video', 'fal_generate', 'edit_video_openrouter', 'higgsfield_generate_image', 'higgsfield_generate_video', 'higgsfield_edit', 'higgsfield_speech']);

function toolDefinitions(viewer = null) {
  const restricted = access.isRestricted(viewer);
  const definitions = BASE_TOOL_DEFINITIONS.slice();
  if (rendernode.enabled()) definitions.push(RENDER_MOTION_GRAPHICS_DEFINITION);
  if (ffmpeg.binaries().available) definitions.push(CONCAT_VIDEOS_DEFINITION);
  if (higgsfield.status().connected && access.higgsfieldAllowed(viewer)) definitions.push(...HIGGSFIELD_TOOL_DEFINITIONS);
  return restricted
    ? definitions.filter((definition) => !Object.prototype.hasOwnProperty.call(INTERNAL_RESOURCE_TOOLS, definition.function?.name))
    : definitions;
}

module.exports = {
  HIGGSFIELD_TOOL_NAMES,
  INTERNAL_RESOURCE_TOOLS,
  PAID_TOOLS,
  ASYNC_PAID_TOOLS,
  toolDefinitions,
  RENDER_MOTION_GRAPHICS_DEFINITION
};
