---
name: nga-figma-bridge
description: Drive Figma through the NGA Figma Bridge MCP tools (figma_*) — read pages and nodes, take screenshots, render HTML files into Figma frames, apply token presets and variables, audit fonts/raw colors, and run any bridge command. Use whenever the user asks to look at, build, edit or audit something in Figma, convert HTML/a web page into Figma, or bind design tokens, and the figma_* tools are available. Also use when figma_* calls fail with PLUGIN_OFFLINE to walk the user through connecting.
---

# NGA Figma Bridge

```
Claude Code ── stdio ──> mcp/server.js (hub on 127.0.0.1:7777, started by Claude Code)
                                ⇅ WebSocket
          Figma desktop: NGA Figma Bridge plugin (window open, 연결 pressed)
```

Claude Code starts the hub automatically. Nothing else to run when Figma is on the same machine.

## Start of every task

1. Call `figma_status`.
2. If `connected` is false, tell the user:
   - Figma → Plugins → (Development →) **NGA Figma Bridge** → press **연결**.
   - Keep the window open. Figma allows one plugin at a time, so close other plugins (e.g. DesignAgent).
   - First time only: Plugins → Development → **Import plugin from manifest…** → `<plugin root>/figma-plugin/manifest.json`.
3. Retry `figma_status` after the user says it is connected.

## Tools

| Tool | Use for |
|---|---|
| `figma_status` | connection, plugin version, running jobs and progress |
| `figma_pages` · `figma_find` · `figma_spec` | locate nodes; `spec` returns geometry, fills, text, auto-layout, bound variables |
| `figma_screenshot` | see a node (returns the image; `out` also saves it) |
| `figma_html` | render a local `.html` file (`file`), a `url` or an `html` string into Figma. Use `replaceId` to redo a frame in place |
| `figma_audit` | fonts in use, raw (unbound) colors, text overflow |
| `figma_tokens_apply` | create and bind variables from a preset (`example` is bundled; pass a JSON path for your own) |
| `figma_command` | every other command: `resize move rename delete clone reparent radius fill stroke text autolayout frame component.create instance.create instance.swapIn vars.list vars.ensure vars.bind vars.mode tokens.values fit.textBoxes batch select selection page.set nodes` |
| `figma_exec` | last resort JS in the plugin sandbox |
| `figma_reload_handlers` | push edited `handlers/*.js` now |

## Rules

- Pages named in `NGA_PROTECTED` (default none) are read-only. Writes fail with `PAGE_PROTECTED`. Do not work around it.
- `figma_exec` bypasses the guard. Never use it to write near a protected page.
- Group many small edits into one `figma_command` `batch` call: `{"cmd":"batch","args":{"ops":[{"cmd":"rename","args":{...}}]}}`.
- Long jobs (`html`, `audit`, `tokens.apply`) default to a 10-minute timeout. `TIMEOUT` means the hub stopped waiting, not that Figma stopped; check `figma_status` jobs before retrying.
- After any visual change, verify with `figma_screenshot`.

## Error codes

`INVALID_INPUT` · `UNKNOWN_COMMAND` · `NOT_FOUND` · `PAGE_PROTECTED` · `PLUGIN_OFFLINE` (plugin not connected) · `TIMEOUT` · `EXEC_UNSUPPORTED` · `FONT_MISSING` (install the font in Figma or change family) · `UI_FAILED` (HTML layout or fetch failed) · `INTERNAL`.

## Several Claude sessions

The first session owns port 7777. Later sessions relay to it. When the owner exits, a relay takes over within about 3 seconds. The Figma plugin reconnects by itself.

## Figma on another machine

Run the hub on the Figma machine (`./deploy.sh <host>` from the repo, or `bun mcp/server.js serve` there), then tunnel and point Claude Code at it:

```sh
ssh -N -L 7778:127.0.0.1:7777 <host>      # local 7778 → remote hub
# set NGA_HUB=http://127.0.0.1:7778 in the environment Claude Code starts with
```

In this remote mode `figma_html` with `file` sends the HTML inline, so relative CSS and image paths do not resolve. Put assets under the remote hub's `NGA_ROOT` and pass `url` instead.
