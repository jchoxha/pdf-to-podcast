// Static configuration: providers, voices, free-tier limits, defaults.

export const APP_VERSION = '1.0.0';
export const WORDS_PER_MIN = 150;      // conversational pace used for planning
export const CHARS_PER_WORD = 5.9;     // avg English chars incl. spaces/punctuation
export const TOKENS_PER_CHAR = 0.27;   // rough English token density (~3.7 chars/token)

// ---------- Script writers (LLMs) ----------
export const LLM_PROVIDERS = {
  gemini: {
    label: 'Google Gemini', free: 'Free tier with a Google AI Studio key',
    keyUrl: 'https://aistudio.google.com/apikey', usageUrl: 'https://aistudio.google.com/rate-limit',
    defaultModel: 'gemini-3.8-flash', models: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
    needsKey: true, maxInputTokens: 400000, minGapMs: 6500,
  },
  groq: {
    label: 'Groq', free: 'Free tier (tight per-minute token limits)',
    keyUrl: 'https://console.groq.com/keys', usageUrl: 'https://console.groq.com/settings/limits',
    base: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
    needsKey: true, maxInputTokens: 6000, minGapMs: 2500, openai: true,
  },
  openrouter: {
    label: 'OpenRouter', free: 'Free models (ids ending in :free, or openrouter/free)',
    keyUrl: 'https://openrouter.ai/keys', usageUrl: 'https://openrouter.ai/activity',
    base: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free', models: ['openrouter/free'],
    needsKey: true, maxInputTokens: 60000, minGapMs: 3500, openai: true,
  },
  anthropic: {
    label: 'Anthropic Claude (API key)', free: 'Paid API (not your Claude.ai plan)',
    keyUrl: 'https://console.anthropic.com/settings/keys', usageUrl: 'https://console.anthropic.com/usage',
    defaultModel: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    needsKey: true, maxInputTokens: 150000, minGapMs: 0,
  },
  custom: {
    label: 'OpenAI-compatible / Local (Ollama, LM Studio)', free: 'Free if running locally',
    keyUrl: 'https://ollama.com/download', usageUrl: '',
    base: 'http://localhost:11434/v1', defaultModel: 'llama3.1', models: [],
    needsKey: false, maxInputTokens: 24000, minGapMs: 0, openai: true,
  },
  claudeai: {
    label: 'Claude (your Claude plan)', free: 'Only available when this app runs inside claude.ai',
    defaultModel: 'default', models: ['default', 'complex', 'quick'], needsKey: false, maxInputTokens: 55000, minGapMs: 0, hidden: true,
  },
};

// ---------- Voice engines ----------
// Kokoro voice metadata (grade = model authors' quality rating)
export const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'F', 'US', 'A'], ['af_bella', 'Bella', 'F', 'US', 'A-'], ['af_nicole', 'Nicole', 'F', 'US', 'B-'],
  ['af_aoede', 'Aoede', 'F', 'US', 'C+'], ['af_kore', 'Kore', 'F', 'US', 'C+'], ['af_sarah', 'Sarah', 'F', 'US', 'C+'],
  ['af_alloy', 'Alloy', 'F', 'US', 'C'], ['af_nova', 'Nova', 'F', 'US', 'C'], ['af_sky', 'Sky', 'F', 'US', 'C-'],
  ['af_jessica', 'Jessica', 'F', 'US', 'D'], ['af_river', 'River', 'F', 'US', 'D'],
  ['am_michael', 'Michael', 'M', 'US', 'C+'], ['am_fenrir', 'Fenrir', 'M', 'US', 'C+'], ['am_puck', 'Puck', 'M', 'US', 'C+'],
  ['am_echo', 'Echo', 'M', 'US', 'D'], ['am_eric', 'Eric', 'M', 'US', 'D'], ['am_liam', 'Liam', 'M', 'US', 'D'],
  ['am_onyx', 'Onyx', 'M', 'US', 'D'], ['am_adam', 'Adam', 'M', 'US', 'F+'],
  ['bf_emma', 'Emma', 'F', 'UK', 'B-'], ['bf_isabella', 'Isabella', 'F', 'UK', 'C'], ['bf_alice', 'Alice', 'F', 'UK', 'D'], ['bf_lily', 'Lily', 'F', 'UK', 'D'],
  ['bm_george', 'George', 'M', 'UK', 'C'], ['bm_fable', 'Fable', 'M', 'UK', 'C'], ['bm_lewis', 'Lewis', 'M', 'UK', 'D+'], ['bm_daniel', 'Daniel', 'M', 'UK', 'D'],
].map(([id, name, g, acc, grade]) => ({ id, name, gender: g, accent: acc, grade }));

export const GEMINI_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
  ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'], ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
].map(([id, desc]) => ({ id, name: id, desc }));

export const TTS_ENGINES = {
  kokoro: { label: 'Kokoro (free, runs in your browser)', needsKey: false, unlimited: true },
  gemini: { label: 'Gemini TTS (free tier, expressive)', needsKey: true, defaultModel: 'gemini-3.8-flash-tts', keyUrl: 'https://aistudio.google.com/apikey' },
  azure: { label: 'Azure neural voices (500K chars/mo free)', needsKey: true, keyUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices' },
  google: { label: 'Google Cloud TTS (1M-4M chars/mo free)', needsKey: true, keyUrl: 'https://console.cloud.google.com/apis/library/texttospeech.googleapis.com' },
};

// Default voice for speaker slot i per engine
export const DEFAULT_VOICES = {
  kokoro: ['af_heart', 'am_michael', 'bf_emma', 'bm_george'],
  gemini: ['Sulafat', 'Achird', 'Aoede', 'Charon'],
  azure: ['en-US-AvaMultilingualNeural', 'en-US-AndrewMultilingualNeural', 'en-US-EmmaMultilingualNeural', 'en-US-BrianMultilingualNeural'],
  google: ['en-US-Chirp3-HD-Aoede', 'en-US-Chirp3-HD-Charon', 'en-US-Chirp3-HD-Leda', 'en-US-Chirp3-HD-Puck'],
};

// ---------- Free-tier limits (editable in Settings; these are starting points) ----------
// window: 'day' | 'month' | 'minute'. 'source' says how sure we are.
export const DEFAULT_LIMITS = {
  'llm:gemini': [{ metric: 'requests', window: 'day', limit: 250, note: 'Free-tier requests/day for Flash models varies by model; check AI Studio' },
                 { metric: 'requests', window: 'minute', limit: 10 }],
  'llm:groq': [{ metric: 'requests', window: 'day', limit: 1000, note: 'Updated live from Groq response headers' },
               { metric: 'tokens', window: 'minute', limit: 8000 }],
  'llm:openrouter': [{ metric: 'requests', window: 'day', limit: 50, note: 'Free models: 50/day (1000/day after a one-time $10 credit purchase)' },
                     { metric: 'requests', window: 'minute', limit: 20 }],
  'llm:anthropic': [],
  'llm:custom': [],
  'llm:claudeai': [],
  'tts:gemini': [{ metric: 'requests', window: 'day', limit: 100, note: 'Preview/TTS free-tier daily limits are low and change often; check AI Studio' },
                 { metric: 'requests', window: 'minute', limit: 3 }],
  'tts:azure': [{ metric: 'chars', window: 'month', limit: 500000, note: 'F0 free tier: 0.5M characters/month for neural voices' },
                { metric: 'requests', window: 'minute', limit: 20 }],
  'tts:google:Chirp3-HD': [{ metric: 'chars', window: 'month', limit: 1000000 }],
  'tts:google:Neural2': [{ metric: 'chars', window: 'month', limit: 1000000 }],
  'tts:google:Studio': [{ metric: 'chars', window: 'month', limit: 1000000 }],
  'tts:google:WaveNet': [{ metric: 'chars', window: 'month', limit: 4000000 }],
  'tts:google:Standard': [{ metric: 'chars', window: 'month', limit: 4000000 }],
  'tts:kokoro': [],
};

export const SERVICE_LABELS = {
  'llm:gemini': 'Gemini (script writing)', 'llm:groq': 'Groq', 'llm:openrouter': 'OpenRouter', 'llm:anthropic': 'Anthropic API',
  'llm:custom': 'Custom / local LLM', 'llm:claudeai': 'Claude (claude.ai plan)',
  'tts:gemini': 'Gemini TTS', 'tts:azure': 'Azure neural TTS', 'tts:kokoro': 'Kokoro (in browser)',
  'tts:google:Chirp3-HD': 'Google TTS · Chirp 3 HD', 'tts:google:Neural2': 'Google TTS · Neural2', 'tts:google:Studio': 'Google TTS · Studio',
  'tts:google:WaveNet': 'Google TTS · WaveNet', 'tts:google:Standard': 'Google TTS · Standard',
};

// ---------- Speaker presets ----------
export const PERSONALITY_PRESETS = [
  { role: 'Host', personality: 'Warm, curious host who asks the questions a smart student would ask, keeps things moving, and checks understanding with quick recaps.' },
  { role: 'Expert', personality: 'Enthusiastic expert who explains clearly with vivid analogies and real-world examples, admits nuance, and never lectures for too long.' },
  { role: 'Skeptic', personality: 'Friendly skeptic who pushes back, asks "but why does that matter?", and surfaces common misconceptions.' },
  { role: 'Student', personality: 'Relatable student who is learning this for the first time, voices confusion honestly, and connects ideas to exams and assignments.' },
  { role: 'Storyteller', personality: 'Storyteller who brings in history, people, and memorable stories behind the ideas.' },
  { role: 'Comedian', personality: 'Quick-witted co-host who adds light humor and memorable mnemonics without derailing the content.' },
];

export const DEFAULT_SPEAKERS = [
  { name: 'Maya', ...PERSONALITY_PRESETS[0] },
  { name: 'Leo', ...PERSONALITY_PRESETS[1] },
  { name: 'Priya', ...PERSONALITY_PRESETS[2] },
  { name: 'Sam', ...PERSONALITY_PRESETS[3] },
];

export const STYLE_OPTIONS = {
  tone: ['Casual and fun', 'Balanced', 'Academic'],
  level: ['Intro / first exposure', 'Undergraduate', 'Advanced / graduate'],
  focus: ['Understand the big ideas', 'Exam prep (definitions, key facts, likely questions)', 'Deep dive (mechanisms, nuance, debates)'],
};

export const DEPTH_PRESETS = [
  { id: 'overview', label: 'Overview', wordsPerMin: 1400 },
  { id: 'standard', label: 'Standard', wordsPerMin: 700 },
  { id: 'deep', label: 'Deep dive', wordsPerMin: 350 },
];

// ---------- CDN assets ----------
// The 21 MB WebAssembly runtime is served from jsDelivr (pinned version) to keep the repo small.
export const ORT_WASM_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.wasm';
export const KOKORO_MODELS = {
  q8: { url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx', mb: 92, device: 'wasm' },
  fp32: { url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx', mb: 326, device: 'webgpu' },
};
export const KOKORO_VOICE_URLS = [
  (id) => `https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/voices/${id}.bin`,
  (id) => `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${id}.bin`,
];

export const KOKORO_VOCAB = {";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177};
