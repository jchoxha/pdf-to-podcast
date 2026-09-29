// Shared app state.
import { DEFAULT_SPEAKERS, DEFAULT_VOICES, STYLE_OPTIONS, LLM_PROVIDERS, TTS_ENGINES } from './config.js';
import { loadSettings, saveSettings } from './store.js';

export const DEFAULTS = {
  llm: { provider: 'gemini', models: Object.fromEntries(Object.entries(LLM_PROVIDERS).map(([k, p]) => [k, p.defaultModel])), base: { custom: LLM_PROVIDERS.custom.base }, maxInputTokens: {} },
  keys: { gemini: '', groq: '', openrouter: '', anthropic: '', custom: '', azure: '', google: '' },
  azureRegion: 'eastus',
  tts: { engine: 'kokoro', geminiTtsModel: TTS_ENGINES.gemini.defaultModel, geminiStyle: 'Read this as a lively, natural podcast conversation.', kokoroDevice: 'wasm' },
  episode: {
    durationMin: 10, speakerCount: 2,
    speakers: DEFAULT_SPEAKERS.map((s, i) => ({ ...s, speed: 1, voices: { kokoro: DEFAULT_VOICES.kokoro[i], gemini: DEFAULT_VOICES.gemini[i], azure: DEFAULT_VOICES.azure[i], google: DEFAULT_VOICES.google[i] } })),
    tone: STYLE_OPTIONS.tone[0], level: STYLE_OPTIONS.level[1], focus: STYLE_OPTIONS.focus[0],
    analogies: true, misconceptions: true, recap: true, quiz: false, custom: '',
  },
};

export const S = loadSettings(DEFAULTS);
export const persist = () => saveSettings(S);

// Runtime (not persisted)
export const R = {
  pdf: null, fileName: '', checked: new Set(), expanded: new Set(), selPages: [], pagesText: '',
  words: 0, wordsExact: false, sourceText: null, sourceKey: '',
  script: null, scriptRun: null, scriptErr: null, scriptBusy: false, scriptStatus: '', scriptProgress: [0, 0], draftLines: null,
  audio: null, audioRun: null, audioErr: null, audioBusy: false, audioStatus: '', audioProgress: [0, 0], audioStart: 0,
  abort: null, episodeId: null, voiceLists: {}, claudeAi: false, suggested: null,
};

export const activeSpeakers = () => S.episode.speakers.slice(0, S.episode.speakerCount);
export function llmConfig() {
  const p = S.llm.provider;
  return { provider: p, model: S.llm.models[p] || LLM_PROVIDERS[p].defaultModel, key: S.keys[p], base: S.llm.base[p], maxInputTokens: +S.llm.maxInputTokens[p] || LLM_PROVIDERS[p].maxInputTokens };
}
export function ttsConfig() {
  return { engine: S.tts.engine, keys: S.keys, azureRegion: S.azureRegion, geminiTtsModel: S.tts.geminiTtsModel, geminiStyle: S.tts.geminiStyle, kokoroDevice: S.tts.kokoroDevice, speakers: activeSpeakers() };
}
