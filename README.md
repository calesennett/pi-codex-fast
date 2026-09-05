# pi-codex-fast

<img width="679" height="485" alt="Screenshot 2026-07-11 at 10 38 19 AM" alt="Screenshot of a pi agent turn that utilizes the `pi-codex-fast` extension. User message reads, 'This is fast!'. Agent responds, 'Glad to hear it!'" src="https://github.com/user-attachments/assets/0d0bdd79-01a4-45ea-a978-da2869e31924" />


This [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension adds Fast and Ultrafast service tiers to supported OpenAI requests.

## Usage

Inside pi:

- `/codex-fast` toggles Fast mode.
- `/codex-ultrafast` toggles Ultrafast mode.

From CLI:

- `pi --fast`
- `pi --ultrafast`

You cannot enable both modes at the same time.

## Persistence

The extension reads the mode from these pi settings files:

- global: `$PI_CODING_AGENT_DIR/settings.json` (or `~/.pi/agent/settings.json`)
- project override: `<cwd>/.pi/settings.json`

Use the key `pi-codex-fast.mode`. The allowed values are `off`, `fast`, and `ultrafast`. The extension also accepts the old `enabled` key.

Writes go to the global settings file.

## Behavior

Fast mode sets `service_tier: "priority"` for these models:

- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`
- `openai-codex/gpt-5.6-luna`
- `openai-codex/gpt-6-astra`

Ultrafast mode sets `service_tier: "ultrafast"` for `openai/gpt-5.6-sol`. Your OpenAI API project must have Ultrafast access.

The extension does not change other requests.

## Example benchmark

A local live benchmark is available in this repository under `evals/`. Three paired trials per model produced:

| Model | TTFB speedup | Turn speedup | Wall speedup |
| --- | ---: | ---: | ---: |
| `gpt-5.6-sol` | 1.52x | 1.58x | 1.57x |
| `gpt-5.6-terra` | 1.05x | 1.34x | 1.33x |
| `gpt-5.6-luna` | 1.30x | 2.31x | 2.25x |
