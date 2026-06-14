# pi-codex-fast

![pi-codex-fast screenshot](https://raw.githubusercontent.com/calesennett/pi-codex-fast/main/assets/pi-codex-fast.png)

Fast-mode extension for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that injects `service_tier: "priority"` into `openai-codex/gpt-5.4` and `openai-codex/gpt-5.5` requests.

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
- the active model is `openai-codex/gpt-5.4` or `openai-codex/gpt-5.5`

All other requests are left unchanged.

## Example benchmark

A local live benchmark is available in this repository under `evals/`; one 3-trial run produced:

```text
Medians
metric  baseline  fast     speedup
------  --------  -------  -------
TTFB    15205ms   11870ms  1.28x
turn    24262ms   16157ms  1.50x
wall    24585ms   16384ms  1.50x
```
