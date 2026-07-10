# pi-codex-fast

![pi-codex-fast screenshot](https://raw.githubusercontent.com/calesennett/pi-codex-fast/main/assets/pi-codex-fast.png)

Fast-mode extension for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that injects `service_tier: "priority"` into supported OpenAI Codex requests.

## Usage

Inside pi:

- `/codex-fast` to toggle

From CLI:

- `pi --fast`

## Persistence

The enabled/disabled state is read from pi's settings files:

- global: `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`)
- project override: `<cwd>/.pi/settings.json`

under the key `pi-codex-fast.enabled`.

Writes go to the global settings file.

## Behavior

The extension only patches provider payloads when all of these are true:

- fast mode is enabled
- the active model is one of:
  - `openai-codex/gpt-5.4`
  - `openai-codex/gpt-5.5`
  - `openai-codex/gpt-5.6-sol`
  - `openai-codex/gpt-5.6-terra`
  - `openai-codex/gpt-5.6-luna`

All other requests are left unchanged.

## Example benchmark

A local live benchmark is available in this repository under `evals/`. Three paired trials per model produced:

| Model | TTFB speedup | Turn speedup | Wall speedup |
| --- | ---: | ---: | ---: |
| `gpt-5.6-sol` | 1.52x | 1.58x | 1.57x |
| `gpt-5.6-terra` | 1.05x | 1.34x | 1.33x |
| `gpt-5.6-luna` | 1.30x | 2.31x | 2.25x |
