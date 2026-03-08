# pi-codex-fast

![pi-codex-fast screenshot](https://raw.githubusercontent.com/calesennett/pi-codex-fast/main/assets/pi-codex-fast.png)

Fast-mode extension for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that injects `service_tier: "priority"` into OpenAI/OpenAI Codex requests.

## Usage

Inside pi:

- `/codex-fast` to toggle

From CLI:

- `pi --fast`

## Persistence

The enabled/disabled state is read via pi's `SettingsManager`:

- global: `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`)
- project override: `<cwd>/.pi/settings.json`

under the key `pi-codex-fast.enabled`.

Writes go to the global settings file, matching pi's default `SettingsManager` behavior.

## Behavior

The extension only patches OpenAI provider payloads when all of these are true:

- fast mode is enabled
- the active model provider is `openai` or `openai-codex`

All other requests are left unchanged.
