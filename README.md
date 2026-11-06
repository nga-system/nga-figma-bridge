# NGA Figma Bridge

A Claude Code plugin plus a Figma plugin that let Claude drive Figma directly. It replaces the DesignAgent Claude Bridge.

```
Claude Code ── stdio ──> mcp/server.js  (hub on 127.0.0.1:7777, started by Claude Code)
                               ⇅ WebSocket
          Figma desktop: NGA Figma Bridge plugin (keep the window open)
```

No server to run by hand. Claude Code starts `mcp/server.js` from `.mcp.json` when a session opens.

## Why it exists

Figma runs only one plugin at a time per file. Under DesignAgent, variables and fonts needed a separate plugin, so the bridge kept disconnecting and every step needed a manual run. This plugin does everything:

- Works across pages (`documentAccess: dynamic-page`). Pages listed in `NGA_PROTECTED` are read-only (writes fail with `PAGE_PROTECTED`).
- Variables: create, bind, set modes. Fonts: family, weight and line height.
- Token presets (`presets/*.json`).
- `html`: renders an HTML page into Figma nodes. The layout is computed by the browser inside the plugin UI, so no headless browser is involved.
- **Live behavior changes:** edit `handlers/*.js` and the hub pushes the file to the plugin. No need to reopen the plugin.
- `exec`: runs any JS snippet in the plugin sandbox (an escape hatch).
- Progress for long jobs: `figma_status` shows the running jobs and their done/total counts.

## Install

1. Claude Code (needs `node` on PATH):
   ```
   /plugin marketplace add nga-system/nga-figma-bridge   # or a local path to this folder
   /plugin install nga-figma-bridge@nextgenai
   ```
   Restart Claude Code. The `figma_*` tools appear.
2. Figma desktop → Plugins → Development → **Import plugin from manifest…** → `figma-plugin/manifest.json`.
3. Run Plugins → Development → **NGA Figma Bridge** and press **연결**. Keep the window open.
   - Do not run DesignAgent or other plugins at the same time (Figma rule).

Several Claude sessions share one hub: the first owns port 7777, later ones relay to it, and a relay takes over when the owner exits.

One-step install (Claude Code 2.1.275+):

```
/plugin install nga-figma-bridge --marketplace nga-system/nga-figma-bridge
```

## MCP tools

`figma_status` `figma_pages` `figma_find` `figma_spec` `figma_screenshot` `figma_html` (file / url / html) `figma_audit` `figma_tokens_apply` `figma_command` (any command below) `figma_exec` `figma_reload_handlers`. Usage rules live in `skills/nga-figma-bridge/SKILL.md`.

## Figma on another machine

`./deploy.sh <ssh host>` builds, copies the Figma plugin to `~/nga-figma-bridge/plugin/` on that host, and starts the hub there (`bun mcp/server.js serve`, port 7777, static files from `NGA_ROOT`, default `~/nga-figma-bridge/files`). Example: `NGA_PROTECTED="Original" ./deploy.sh figma-host`. Then either:

- Use the CLI below over ssh, or
- Tunnel (`ssh -N -L 7778:127.0.0.1:7777 <host>`) and start Claude Code with `NGA_HUB=http://127.0.0.1:7778`.

Environment: `NGA_PORT` (7777; the Figma plugin connects to 7777) · `NGA_PROTECTED` (comma list of read-only page names, default none) · `NGA_ROOT` (static `/files` root) · `NGA_HUB` (use a remote hub).

## CLI (remote setup)

Set `NGA_HOST=<ssh host>` (or pass `--host`). `bun cli/selftest.ts` runs a live end-to-end check.


```sh
bun cli/fb.ts status                                    # connection, plugin version, jobs in progress
bun cli/fb.ts pages
bun cli/fb.ts find '{"page":"Design","name":"Home","deep":false}'
bun cli/fb.ts spec '{"id":"12:345","depth":2}'
bun cli/fb.ts screenshot '{"id":"12:345","scale":0.5}' --out home.png
bun cli/fb.ts html '{"url":"site/home.html","width":1440,"page":"Design","x":0,"y":0}' --timeout 600000
bun cli/fb.ts html '{"url":"site/home.html","width":1440,"replaceId":"12:345"}'
bun cli/fb.ts tokens.apply '{"ids":["12:345"]}' --preset example        # or --preset ./my-brand.json
bun cli/fb.ts audit '{"page":"Design"}' --timeout 600000
bun cli/fb.ts batch '{"ops":[{"cmd":"resize","args":{"id":"1:2","width":200}},{"cmd":"rename","args":{"id":"1:2","name":"x"}}]}'
bun cli/fb.ts exec '{"code":"return figma.currentPage.name"}'
bun cli/fb.ts put ./site/new.html site/new.html          # upload a file under the server root
```

## Commands

| Area | Commands |
|---|---|
| Read | `ping` `pages` `page.set` `nodes` `find` `spec` `select` `selection` `screenshot` `audit` |
| Edit | `resize` `move` `rename` `delete` `clone` `reparent` `radius` `fill` `stroke` `text` `autolayout` `frame` |
| Components | `component.create` `instance.create` `instance.swapIn` |
| Variables | `vars.list` `vars.ensure` `vars.bind` `vars.mode` `tokens.values` `tokens.apply` `fit.textBoxes` |
| Render | `html` |
| Control | `batch` `exec` |

DesignAgent mapping:

| DesignAgent | NGA Figma Bridge |
|---|---|
| `list_page_nodes` | `nodes` |
| `get_spec` | `spec` |
| `html_to_design` | `html` |
| `take_screenshot` | `screenshot` |
| `set_corner_radius` | `radius` |
| `set_text_style` | `text` |
| `list_variables_and_styles` | `vars.list` |

## Contract

- Envelope: `mcp/src/protocol.ts` (single owner). `figma-plugin/core.js` repeats the same `ERROR_CODES`. The hub logs any mismatch at connect time.
- Error codes:
  - `INVALID_INPUT`, `UNKNOWN_COMMAND`: CLI exit code 2.
  - `PLUGIN_OFFLINE`, `TIMEOUT`: exit code 3.
  - `PAGE_PROTECTED`: exit code 4.
  - `NOT_FOUND`: exit code 5.
  - `EXEC_UNSUPPORTED`: exit code 6.
  - `FONT_MISSING`: exit code 7.
  - `UI_FAILED`, `INTERNAL`: exit code 1.
- `TIMEOUT` means the hub stopped waiting. The job may still be running in Figma, so check `status`.
- The plugin runs one command at a time. A second command waits in the queue.

## Limits (v0.2)

- `html`:
  - Not converted: `::before`/`::after` pseudo-elements, CSS `transform`, `grid` (placed with absolute coordinates), and inset shadows.
  - A flex container becomes auto-layout when it has no margins and no per-child `align-self`. Otherwise its children get absolute coordinates.
- `exec` can bypass the protected-page guard. Use the dedicated commands for anything that touches the original.

## Edit → apply

- `bun build.ts` rebuilds `figma-plugin/code.js` and `mcp/server.js` (commit both; users run the bundle, no `node_modules`).
- `handlers/*.js`: the hub watches the folder and pushes changes live (remote: `./deploy.sh`).
- `figma-plugin/core.js` · `ui.html` · `manifest.json`: rebuild, then close and reopen the plugin in Figma.
- `mcp/src/*`: rebuild, then restart Claude Code (remote: `./deploy.sh` restarts the hub; the plugin reconnects on its own).

## License

MIT — see `LICENSE`.
