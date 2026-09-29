# PDF to Podcast

Turn chapters, sections or page ranges of a textbook PDF into a conversational study podcast. It runs entirely in your browser and is hosted free on GitHub Pages.

- **Pick material:** chapter/section tree from the PDF's bookmarks, or page ranges. Running headers, footers and page numbers are stripped automatically.
- **Length suggestion:** Overview, Standard or Deep dive, based on how many words you picked. Any length from 2 to 90 minutes.
- **1 to 4 speakers:** names, personalities (presets or your own), voice, speed and voice blending.
- **Script writers:** Google Gemini (free key), Groq (free), OpenRouter (free models), Anthropic API, or any OpenAI-compatible or local model (Ollama, LM Studio). You can review and edit every line before any audio is made.
- **Voices:** Kokoro (free, unlimited, runs on your device), Gemini TTS, Azure neural voices, Google Cloud TTS.
- **Usage tracking:** an estimate before every generation, live meters against each service's free-tier limits, and a report after each run.
- **Library:** episodes (script + MP3) are saved in your browser. Downloads come as MP3, WAV and a Markdown transcript.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (public, or private if your plan includes Pages for private repos).
2. Upload **the contents of this folder** to the repository root. With the GitHub website: **Add file → Upload files**, drag everything in, then commit. With git:
   ```bash
   git init && git add . && git commit -m "PDF to Podcast"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. In the repo go to **Settings → Pages**. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: main / (root)**, then Save.
4. After a minute your app is live at `https://<you>.github.io/<repo>/`.

No build step is needed. The ONNX Runtime WebAssembly binary (21 MB) is loaded from jsDelivr at a pinned version.

## Getting free keys

| Service | Used for | Free allowance (check the provider, these change) | Where |
|---|---|---|---|
| Google Gemini | Scripts + Gemini voices | Free tier on Flash models and Gemini TTS; daily request caps vary by model | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Groq | Scripts | Free tier; limits come back live in response headers | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenRouter | Scripts | `:free` models, about 50 requests/day (1,000/day after a one-time $10 credit) | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Azure Speech (F0) | Voices | 500K characters/month of neural voices | [Azure portal](https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices) |
| Google Cloud TTS | Voices | 1M chars/month (Chirp 3 HD, Neural2, Studio), 4M (WaveNet, Standard); billing account required | [Cloud console](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com) |
| Kokoro | Voices | Unlimited, no key; runs on your computer | n/a |

Paste keys in **Settings**. They are stored only in your browser's localStorage and sent only to the matching provider. Anyone using your Pages site brings their own keys; yours are never in the repo.

**Security note for Google keys:** in Google Cloud, restrict the API key to the Text-to-Speech API (and optionally to your Pages URL as an HTTP referrer).

## How it works

- `js/pdf.js`: PDF.js loads the file locally, reads the outline and extracts text.
- `js/scriptgen.js`: splits the material into segments. For material too large for the model, it condenses each part into notes first. It then plans the episode arc and writes each segment with the previous lines as context.
- `js/tts.js` + `js/kokoro-worker.js`: voice engines. Kokoro runs the 82M-parameter model with ONNX Runtime Web in a Web Worker, multithreaded thanks to `coi-serviceworker.js`, with WebGPU optional.
- `js/usage.js`: the usage ledger, free-tier limits and estimates.

The first Kokoro use downloads the model (92 MB) from Hugging Face. Your browser then caches it.

## Credits & licenses

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0); text processing adapted from [kokoro-js](https://github.com/hexgrad/kokoro) (Apache-2.0)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT)
- [phonemizer.js](https://github.com/xenova/phonemizer.js) (Apache-2.0, bundles eSpeak NG data, GPL-3.0)
- [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0)
- [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0)
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT)
