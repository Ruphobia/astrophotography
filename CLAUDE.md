# Astrophotography Web App — Project Rules

Read this every session before making changes.

## What this project is
A web-based astrophotography image processing application, written in Python 3, served locally and accessible from outside the machine.

## Hard rules — do not violate

1. **Single HTML page.** This is a browser application (SPA-style). There is exactly ONE HTML file: `www/index.html`. Do NOT add more HTML pages. All new UI goes into that page or into JS/CSS that it loads.
2. **Static assets live in `./www/`.** All CSS, JS, HTML, images, fonts go under `www/`. Nothing else.
3. **Python 3.** Server-side code is Python 3.
4. **Launch by name, not `python3 ...`.** The app is started by running `./astrophoto` (executable script with shebang) — never by asking the user to type `python3 something.py`.
5. **Port 6991, externally accessible.** Bind to `0.0.0.0:6991` so it is reachable from other machines, not just localhost.
6. **Dark theme.** UI is dark by default.

## UX rules
- **No browser popups.** Do not use `alert()`, `confirm()`, or `prompt()`. Use inline forms, in-page panels, and the toast system in `www/script.js` for user feedback.
- All UI is dark by default; palette lives in CSS variables on `:root` in `www/style.css`.

## Layout

```
astrophotography/
├── CLAUDE.md         # this file
├── README.md
├── .gitignore        # ignores data/ (runtime uploads)
├── astrophoto        # executable launcher (shebang python3)
├── data/             # runtime, gitignored: projects.json + per-project files
│   └── <project-id>/originals/…
└── www/
    ├── index.html    # the ONE page (contains <template>s for each view)
    ├── style.css
    └── script.js
```

## Data model — non-destructive editing

Originals **are never modified**. All edits are represented as an ordered pipeline of operations that the server re-applies on demand:

- Per project the disk layout is `data/<id>/originals/` (uploads) and `data/<id>/outputs/` (saves from the editor).
- The client (`www/script.js`) owns the current pipeline as `state.editor.ops` (an array of `{op: "kind", ...params}` items) plus a `redo` stack.
- Undo pops from `ops` onto `redo`; redo does the reverse. Any user gesture that adds a new op clears the redo stack.
- The server never persists the pipeline. On preview and on save, the client sends `{source, operations}` and the server renders fresh from the original.

Supported ops (see `apply_operations` in `astrophoto` and `describeOp` in `script.js`): `auto_stretch`, `levels`, `brightness`, `contrast`, `gamma`, `saturation`, `sharpen`, `denoise`, `blur`, `rotate`, `flip_h`, `flip_v`, `grayscale`, `invert`. Unknown ops are ignored so older pipelines still render.

## HTTP API (implemented in `astrophoto`)
- `GET  /api/projects` → `{ projects }`
- `POST /api/projects` (JSON `{name, description}`) → `{ project }`
- `GET  /api/projects/<id>` → `{ project, inputs, outputs }` (each file: `{name, size, modified_at, editable}`)
- `POST /api/projects/<id>/images?name=<filename>` — body = raw file bytes, `Content-Length` required → `{ image }`
- `GET  /api/projects/<id>/inputs/<name>` — original file bytes
- `GET  /api/projects/<id>/outputs/<name>` — saved output file bytes
- `POST /api/projects/<id>/preview` — JSON `{source, operations, max?}`, returns JPEG bytes of the downscaled preview
- `POST /api/projects/<id>/outputs` — JSON `{source, operations, output_name, format, quality?}` → `{ output }`
- `DELETE /api/projects/<id>/outputs/<name>` → `{ ok: true }`
- Legacy alias: `GET /api/projects/<id>/images/<name>` maps to `inputs/`.

Uploads are streamed to disk in 1 MiB chunks; do not read the whole body into memory.
Extension sets are `UPLOAD_EXT` (accepted for upload) and `EDITABLE_EXT` (the editor can process) in both `astrophoto` and `www/script.js` — keep them in sync.

## Editing outputs

Outputs are editable too. Both `POST /api/projects/<id>/preview` and
`POST /api/projects/<id>/outputs` accept an optional `source_kind` field
(`"inputs"` — default — or `"outputs"`). The client sends this whenever an
Output tile's Edit button is used.

## Streak / trail removal

`{"op":"remove_streak","angle":deg,"vertical_radius":n,"horizontal_radius":n,"threshold":n}`
uses scipy `median_filter` twice (perpendicular + along the streak), classifies
pixels that are bright vertically AND extended horizontally as streaks, and
replaces them with the perpendicular median. Requires numpy + scipy (both come
with Pillow's environment).

## Chat drawer

Editor page has a **Chat** toggle. The drawer runs in two modes:

- **Claude** — an xterm.js terminal in the browser talking to a real `claude`
  CLI over a **WebSocket at `/ws/chat/<pid>`**. The server terminates the WS
  frame protocol inline in `http.server` (no extra deps), stores per-project
  tmux sessions (`astrophoto_chat_<pid>`) that survive page reloads, and pipes
  pane bytes to the client via a base64-framed JSON `{type:"data",b64:"…"}`
  message. Input from xterm goes back as `{type:"input",data:"…"}`.
  - Launcher: `bin/astrophoto-chat-claude` runs `claude --model claude-opus-4-7 --dangerously-skip-permissions --disallowedTools "Write Edit MultiEdit NotebookEdit" --append-system-prompt "$(envsubst <chat_prompt.md)"`.
  - cwd is `data/<pid>/` so Claude sees `originals/` and `outputs/` directly.
  - Persona (`chat_prompt.md`) teaches Claude the operation schema and the
    curl shape for the preview / save endpoints.

- **InstructIR** — HuggingFace `marcosv/InstructIR` model, loaded lazily on
  first call. Weights live in `models/instructir/`, source code in
  `models/instructir_src/`. Endpoint: `POST /api/projects/<pid>/instructir`
  with `{source, source_kind, instruction, mode: "preview"|"save"}` — preview
  returns JPEG bytes, save writes into `outputs/` and returns JSON.
  Wrapper: `instructir_runtime.py`.

## Compare (side-by-side)

Editor header **Compare** toggle. When on, the canvas splits into two panes
showing the original (fetched once via `/preview` with empty ops) next to the
current edited preview. Toggling doesn't reset the pipeline.

## Archive uploads

`POST /api/projects/<id>/images?name=<archive>` also accepts `.zip`, `.tar`,
`.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tgz`, `.tbz`, `.tbz2`, `.txz`. The server
streams the raw upload to a temp file, then extracts each contained image
with a supported extension into `originals/` (unique-suffixed on collision).
The response shape is different from a plain image upload:

```json
{
  "archive": {"kind": "zip", "name": "bundle.zip"},
  "extracted": [{name, size, modified_at, editable}, …],
  "skipped":   [{name, reason}, …]
}
```

Traversal safety: `safe_filename(basename(member))` before writing, so archive
members can never escape `originals/`. Directory members inside archives are
ignored.

## FITS

`.fits`, `.fit`, `.fts` are now first-class editable inputs. The server-side
`load_source_as_rgb()` uses `astropy.io.fits` to open FITS files and applies
a 0.5% / 99.5% percentile stretch to 8-bit RGB before the pipeline runs.
2-D data → grayscale-in-RGB; 3-D with a size-3 axis → colour (channel axis
auto-detected). `render_pipeline()` and the InstructIR handler both go
through the same loader.

Requires astropy (`pip install --user --break-system-packages astropy` on
Ubuntu 24 / Python 3.12).

## Not yet supported (followups)
- RAW decoding (`rawpy`).
- Bayered FITS (needs demosaic before percentile stretch).
- Crop with rubber-band selection.
- Delete inputs.
- Persist named presets of pipelines.

## Style notes
- Keep dependencies minimal. Prefer Python stdlib unless a real need justifies adding a package.
- Keep the launcher a single file until complexity forces otherwise.
- Views are rendered by cloning `<template>` elements in `index.html`; add new views the same way rather than injecting inline HTML strings.
