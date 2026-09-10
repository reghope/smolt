# llama.cpp

Smolt supports the [llama.cpp](https://github.com/ggml-org/llama.cpp) router server. The router discovers multiple GGUF models and loads or unloads them on demand.

Use a current llama.cpp build with router support. Follow the [build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) or install a [prebuilt release](https://github.com/ggml-org/llama.cpp/releases) for your platform.

## Start the router

Start `llama-server` without `--model` or `-m`. Passing a model starts single-model mode instead of router mode.

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

Important options:

- `--models-dir ~/models` discovers local GGUF files.
- `--no-models-autoload` keeps loading explicit through `/llama`.
- `--jinja` enables compatible chat templates and tool calling.
- `-ngl 999` offloads as many layers as possible to the GPU.
- `-c 32768` sets the context window for each loaded model. Omit it to use the model's native context, which may require substantially more memory.

A single-file model can sit directly in the model directory. Put multimodal and multi-shard models in separate subdirectories:

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

Restart the router after manually adding files. For per-model context sizes and other options, use [llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets).

## Configure Smolt

Start Smolt and configure the provider:

```text
/login llama.cpp
```

Enter the router URL and optional API key. The default URL is `http://127.0.0.1:8080`.

If you start the router with `--no-models-autoload`, `/login llama.cpp` only stores the connection. Run `/llama` to load a model, then `/model` to select the loaded model for the current session.

Environment variables can configure the same values without `/login`:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
smolt
```

If the server uses an API key, start `llama-server` with the matching `--api-key` value. Keep `--host 127.0.0.1` for local-only access.

## Pick a model

Choosing a llama.cpp model with `/model` (or the desktop model menu) is the whole request. Smolt:

1. Checks the configured server and, when the URL is local and nothing answers, starts `llama-server` in router mode over the folder that holds the chosen model. The folder is `LLAMA_MODELS_DIR`, then `~/models`, then a `models` folder at the root of any drive on Windows. A `presets.ini` beside the models is passed as `--models-preset`. Every installed `llama-server` build is asked what devices it can see, and the first that lists a GPU is used: a CUDA build on a driver that is too old for it lists none and would run on the CPU. If no build is installed, Smolt installs the Vulkan build with scoop, or llama.cpp with winget on Windows or Homebrew on macOS and Linux.
2. Unloads every other loaded or sleeping model, so only one model sits in VRAM at a time.
3. Loads the chosen model and waits for it. Each stage is written into the chat itself, since a load can take minutes: which model is being stopped, that the chosen one is loading into memory, and when it is ready with its context size. The pick returns at once; the first message waits for the load.
4. Reads the loaded model's own properties. Replies are capped at 32k output tokens, whatever the context size; asking for a reply as long as the window is something llama.cpp can only honour with an empty context. The context size shown is the one the model was really started with, and a model whose chat template can switch thinking on gets Smolt's thinking levels, sent through `chat_template_kwargs` and read back from `reasoning_content`.

A model restored when a session reopens is not treated as a pick: nothing is started or unloaded until you send a message. Every turn on a llama.cpp model first confirms it is loaded and alone on the server, so a model another agent loaded in between is stopped before the turn runs. Set `LLAMA_SERVER_PATH` to point at a llama-server that is not on the PATH, and `LLAMA_MODELS_DIR` when the GGUF files are not in `~/models`.

## Manage models

Run:

```text
/llama
```

- Select an unloaded model to load it.
- Select a loaded model to unload it.
- Select **Download model…**, search Hugging Face, then choose a repository and quantization. Exact `owner/repository[:quant]` values also work.
- Press Escape during a load or download to confirm cancellation.

Hugging Face search uses `HF_TOKEN` when set, then checks `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Search also works without authentication, subject to lower rate limits. Smolt warns before downloading gated repositories and links to their access page. The llama.cpp server performs the download, so its process must also have `HF_TOKEN` when the selected repository requires access.

If other models are loaded, Smolt asks whether to unload them first or keep them loaded. Smolt does not silently unload models and never deletes model files. The router may be shared with other clients, so `/llama` always displays the router's current state.

Only loaded models appear in `/model`. After loading a model, run `/model` to select it for the current Smolt session.

If the router disconnects, `/llama` shows **Retry** and **Close**. Retry reconnects and refreshes model state without replaying the interrupted operation.

## Troubleshooting

Check that the router is reachable:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **No models in `/llama`:** Check `--models-dir`, the directory layout, and restart the router.
- **Model missing from `/model`:** Load it with `/llama` first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.
