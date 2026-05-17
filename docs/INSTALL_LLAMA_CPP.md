# Switching from Ollama to llama.cpp

PAS supports both Ollama (`type: ollama`) and llama.cpp (`type: llama-cpp`) as local LLM providers, and they can coexist. This guide walks through installing llama.cpp's `llama-server`, configuring PAS to use it, and (optionally) decommissioning Ollama.

**Trade-off up front.** Ollama is easier — it has a model registry (`ollama pull`), automatic chat templating, and a daemon that loads/unloads models on demand. llama.cpp gives you more control (sampling, GBNF grammars, fewer process layers) but you manage GGUF files and `llama-server` yourself.

**You don't have to choose.** PAS lets you keep Ollama installed and add llama.cpp as a second provider. You can pin individual tiers (`fast`, `standard`, `reasoning`) to whichever one you prefer.

---

## TODO checklist

Copy this into your tracker. Each step has a "verify" command so you can confirm it worked.

### 1. Install `llama-server`

- [ ] **macOS (Homebrew):** `brew install llama.cpp`  
  Verify: `which llama-server` should print `/opt/homebrew/bin/llama-server` (Apple Silicon) or `/usr/local/bin/llama-server` (Intel).
- [ ] **From source (any OS):** `git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && cmake -B build -DGGML_METAL=on && cmake --build build --config Release`. The binary lands at `build/bin/llama-server`. Add it to PATH or use the full path.

### 2. Download a GGUF model

llama.cpp uses GGUF files directly — there's no `ollama pull`-style registry. Pick a model from Hugging Face (search "GGUF" + the model name) and download it.

- [ ] Pick a directory to hold GGUFs: `mkdir -p ~/llama-models`
- [ ] Download a model. Examples:
    - Gemma 3 4B (small, fast): `curl -L -o ~/llama-models/gemma-3-4b-it-q8.gguf https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q8_0.gguf`
    - Llama 3.2 3B (general-purpose): search Hugging Face for `Llama-3.2-3B-Instruct-GGUF`
- [ ] Verify: `ls -lh ~/llama-models/*.gguf` — should show the file with non-zero size.

### 3. Start `llama-server`

- [ ] Run in a long-lived terminal (or wrap in `launchctl`/`systemd`):
   ```
   llama-server \
     -m ~/llama-models/gemma-3-4b-it-q8.gguf \
     --port 8080 \
     --alias local-model \
     --ctx-size 8192
   ```
   The `--alias local-model` flag is important — it makes the model report as `"local-model"` at `/v1/models`, which matches the `default_model` in the PAS config example. If you skip `--alias`, the model id will be the GGUF filename and you must match `default_model` accordingly.
- [ ] Verify the server is up: `curl -s http://localhost:8080/v1/models | jq` — should print `{"object":"list","data":[{"id":"local-model",...}]}`.
- [ ] Verify a quick chat works:
   ```
   curl -s http://localhost:8080/v1/chat/completions \
     -H 'content-type: application/json' \
     -d '{"model":"local-model","messages":[{"role":"user","content":"say PONG"}],"max_tokens":16}' | jq -r '.choices[0].message.content'
   ```

### 4. Configure PAS

- [ ] Edit `config/pas.yaml` and add an `llm.providers.llama-cpp` block (uncomment the commented example near the top of the `llm:` section):
   ```yaml
   llm:
     providers:
       llama-cpp:
         type: llama-cpp
         name: "llama.cpp"
         base_url: http://localhost:8080
         default_model: local-model
   ```
   No `api_key_env` needed — `llama-server` doesn't authenticate.

- [ ] **Optional — pin a tier to llama-cpp.** By default, auto-assignment prefers anthropic/google/openai over local. To force fast-tier traffic to llama.cpp, add:
   ```yaml
   llm:
     tiers:
       fast:
         provider: llama-cpp
         model: local-model
       standard:
         provider: anthropic       # or another remote provider you have keys for
         model: claude-sonnet-4-20250514
   ```
   You can also set this at runtime via the `/gui/llm` admin page.

- [ ] Restart PAS: `pnpm dev` (or your production launcher).

### 5. Verify end-to-end inside PAS

- [ ] Open `/gui/llm/available-models` — `local-model` should appear under the `llama-cpp` provider with input/output price columns reading `$0.00`.
- [ ] Optional sanity script: `pnpm tsx scripts/smoke-llama-cpp-provider.ts` runs a real round-trip (defaults to `http://localhost:11434/v1` for Ollama parity; set `LLAMA_CPP_BASE_URL=http://localhost:8080 LLAMA_CPP_MODEL=local-model` to target llama-server directly).
- [ ] Send yourself a Telegram message — if the fast tier is pinned to llama-cpp, the chatbot reply should come back via your local server (check `llama-server`'s stdout for the inbound request).
- [ ] Check the cost log: `cat data/system/llm-usage.md` — the llama.cpp request should show `$0` in the cost column.

### 6. (Optional) Stop using Ollama

Only do this if you're confident llama.cpp is meeting your needs.

- [ ] Remove `OLLAMA_URL` from `.env` (or set it empty). PAS will skip the Ollama provider on next startup.
- [ ] **Stop the daemon:** `launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist` (or kill the process: `pkill ollama`).
- [ ] **Uninstall (only if you're sure):** `brew uninstall ollama && rm -rf ~/.ollama` — frees up disk space from cached models.
- [ ] Restart PAS and confirm `/gui/llm/available-models` no longer lists Ollama models.

---

## Common issues

- **`/v1/chat/completions` returns 400 "model not found"** — your `default_model` in `pas.yaml` doesn't match what `llama-server` is reporting. Run `curl http://localhost:8080/v1/models` and use whatever id appears there (or add `--alias local-model` to the server command).
- **PAS logs `llama-cpp provider has no default_model configured; falling back to "local-model"`** — your YAML omits `default_model`. The fallback only works if `--alias local-model` is set; either fix one or the other.
- **PAS logs `Provider skipped — no API key set` for llama-cpp** — shouldn't happen since the round-1 Codex fix. If it does, you're on an old build; pull main and rebuild.
- **Image input fails immediately** — expected. `LlamaCppProvider` has `supportsVision = false` by default because most `llama-server` setups don't load a multimodal projector. If you've configured one explicitly, file a follow-up; PAS doesn't have a YAML surface for it yet.

---

## When to use which

| Concern | Ollama | llama.cpp |
|---------|--------|-----------|
| Easy install + model registry | ✅ `ollama pull <name>` | ❌ Manual GGUF download |
| Automatic chat templating | ✅ Per-model template | Server-side (from GGUF metadata) |
| On-demand model loading | ✅ Daemon manages | ❌ One model per `llama-server` |
| Sampling/grammar control | Limited | ✅ Full (GBNF) |
| Multiple processes | One daemon | One process per model |
| PAS pricing/cost | $0 (local) | $0 (local) |
| PAS support | `type: ollama` | `type: llama-cpp` |
