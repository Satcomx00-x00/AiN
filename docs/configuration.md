# Configuration by environment variables

Every address and folder AiN has built in can be overridden by an `AIN_*` environment variable, set
before the app starts: to use a mirror, a fork's plugin store, a local server for tests, or keep
everything in one folder (a portable install). Unset or blank means the default. The list lives in
[`src-tauri/src/config.rs`](../ain/src-tauri/src/config.rs); a test fails if one is missing here.

| Variable | Default | What it changes |
| --- | --- | --- |
| `AIN_STORE_URL` | `https://raw.githubusercontent.com/Satcomx00-x00/AiN/store/store.yaml` | The community plugin store's catalog. |
| `AIN_GITHUB_RAW_URL` | `https://raw.githubusercontent.com` | Where store plugins are downloaded from (`{base}/{owner}/{repo}/{ref}/{entry}`). |
| `AIN_GITHUB_URL` | `https://github.com` | GitHub, for the releases page and their `latest.json`. |
| `AIN_REPO` | `Satcomx00-x00/AiN` | The repository whose releases the updater follows. |
| `AIN_UPDATE_URL` | `{AIN_GITHUB_URL}/{AIN_REPO}/releases/latest/download/latest.json` | The updater's `latest.json` (see [updates](updates.md)). Signatures are checked all the same. |
| `AIN_HF_URL` | `https://huggingface.co` | Hugging Face: dictation's models, and PersonaPlex's (passed to it as `HF_ENDPOINT`). |
| `AIN_TTS_MODELS_URL` | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models` | The read-aloud voices (`{base}/{model}.tar.bz2`). |
| `AIN_TORCH_INDEX_URL` | `https://download.pytorch.org/whl/cu124` (PyPI on macOS) | PyTorch's package index for the local PersonaPlex server. |
| `AIN_PROVIDER_OPENAI_URL` | `https://api.openai.com/v1` | The OpenAI preset's address in Settings → AI providers. |
| `AIN_PROVIDER_GROQ_URL` | `https://api.groq.com/openai/v1` | The Groq preset's address. |
| `AIN_PROVIDER_MISTRAL_URL` | `https://api.mistral.ai/v1` | The Mistral preset's address. |
| `AIN_PROVIDER_CUSTOM_URL` | `http://localhost:8000/v1` | The custom (OpenAI-compatible) preset's address. |
| `AIN_CONFIG_DIR` | the OS's app config folder | Where `settings.json` and the plugins folder are. |
| `AIN_DATA_DIR` | the OS's app data folder | Where downloaded models are kept by default (`models/`). |
| `AIN_INSECURE_TLS` | off | `1`, `true`, `yes` or `on` accepts any server certificate, whatever the settings say ([offline](offline.md)). |
| `AIN_MODELS_SOURCE` | the settings' models source | A folder or URL laid out like the models folder, used instead of the internet ([offline](offline.md)). |

Notes:

- Preset addresses only fill in new providers; a provider already saved keeps its own address,
  which Settings edits.
- A folder chosen in a feature's settings wins over `AIN_DATA_DIR`.
- The PersonaPlex install also honours the usual `UV_INDEX_URL` / `PIP_INDEX_URL` for its other
  packages, and an `HF_ENDPOINT` of your own when `AIN_HF_URL` is unset.

```sh
# A mirror, a fork's store and a self-contained install
AIN_HF_URL=https://hf-mirror.example \
AIN_STORE_URL=https://raw.githubusercontent.com/me/AiN/store/store.yaml \
AIN_CONFIG_DIR=~/ain/config AIN_DATA_DIR=~/ain/data \
ain
```
