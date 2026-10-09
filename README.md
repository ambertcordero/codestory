# CodeStory

Turn source code into an interactive, readable story. CodeStory has a plain
HTML/CSS/JavaScript front end and a local **Python + FastAPI** backend that
imports, stores and statically analyses projects. An optional local
[Ollama](https://ollama.com) model can write project stories.
**No cloud AI and no internet access are required.** Imported code is never
executed.

## Getting started

### 1. Front end

Open `index.html` in a browser (or serve the folder with XAMPP at
`http://localhost/codestory/`). The splash screen links to `dashboard.html`.

### 2. Backend (required for imports)

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The front end calls the backend at `http://127.0.0.1:8000` by default. To point
elsewhere, set `window.CODESTORY_API_BASE` before `js/pages/import.js` loads.

## Import methods

Open the import dialog from **Upload & Analyze Project** on the Overview page.
All methods work locally and never execute the imported source code.

| Method | How it works |
| --- | --- |
| Upload ZIP | Sends a `.zip` archive to the backend, which extracts and validates it in memory. |
| Upload Folder | Reads a chosen folder recursively using the browser's folder picker (`webkitdirectory`). |
| Multiple Files | Imports several selected files at once. |
| Individual File | Imports a single source file. |
| Paste Code | Sends a pasted snippet plus a file name for language detection. |
| Demo Project | Review and load the built-in **Simple POS System** demo (see below). |

Every successful import is stored by the backend and becomes the current
project.

## Built-in demo project

**Try Demo Project** on the Overview page (or **Demo Project** in the import
dialog) opens the bundled **Simple POS System**. Its real source lives in
`simple-pos-demo/` and is served by `GET /api/demo`, so you can review the file
list and preview each file before choosing what to analyze. Selected files go
through the same import, storage and analysis pipeline as any other project, are
labelled **Built-in Demo Project**, and produce a real System Map and Issues
report. Story generation uses the same local Ollama model as any project.

The demo is a small offline point of sale written in plain HTML, CSS and
JavaScript: a product list, a cart with quantity controls, automatic
subtotal/VAT/total calculation and a simulated cash checkout. Open
`simple-pos-demo/index.html` through a web server (for example
`http://localhost/codestory/simple-pos-demo/index.html`) to run it.

## Workspace views

Use the sidebar (or the mobile bottom bar) to switch between four views:

| View | What it does |
| --- | --- |
| **Home** | The original Overview / Story / Issues / System Map tabs. |
| **My Projects** | Lists stored projects with size, languages and dates. Filter, open in Explorer, re-analyze or delete. |
| **My Explorer** | Per-project **Story**, **System Map** (import graph) and **Issues** (static findings). |
| **Settings** | Local AI connection, analysis preferences and stored-data management. |

## Local AI (Ollama)

Story generation is optional and uses a model running on your machine:

```bash
# after installing Ollama from https://ollama.com
ollama serve
ollama pull qwen2.5-coder:3b
```

Configure the host and model in **Settings** and press **Check connection**.
If Ollama is not running, CodeStory reports the real status and shows setup
guidance instead of failing silently. Project files are sent only to the local
Ollama endpoint.

## Stored data

Imported projects are written to `backend/data/` (metadata in `index.json`,
source under `projects/<id>/files/`, cached stories in `stories/`). This folder
is git-ignored. Clear everything from **Settings → Stored data**, or with
`DELETE /api/data`.

## Supported file types

- Web: `.html`, `.css`, `.js`, `.ts`, `.jsx`, `.tsx`
- Backend: `.py`, `.java`, `.php`, `.go`, `.rs`, `.cs`
- Data / configuration: `.sql`, `.json`, `.xml`, `.yaml`, `.yml`, `.toml`, `.ini`
- Documentation: `.md`, `.txt`

## Validation and limits

- Per file: **1 MB**; per project: **200 MB** and **10,000 files**.
- ZIP upload: **200 MB**, max **20,000** entries, with a zip-bomb guard.
  Entries are streamed one at a time, so large archives never sit fully in
  memory. Folder selections above ~250 files are packed into a ZIP in the
  browser and uploaded as a single archive.
- All limits are configurable: `CODESTORY_MAX_FILE_SIZE`,
  `CODESTORY_MAX_TOTAL_SIZE`, `CODESTORY_MAX_FILE_COUNT`,
  `CODESTORY_MAX_UPLOAD_SIZE`, `CODESTORY_MAX_ZIP_ENTRIES` and
  `CODESTORY_MAX_UNCOMPRESSED_SIZE` environment variables, plus per-file /
  per-total / per-count overrides in **Settings → Analysis preferences**.
- Excluded automatically: secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, ...),
  dependency folders (`node_modules`, `vendor`, `.venv`, ...), generated files
  (`dist`, `build`, `*.min.*`, lock files, ...), binary files, duplicate paths
  and unsafe paths.
- The backend only reads and counts bytes; it never executes imported code.

## Folder structure

```
codestory/
├── index.html              Splash / landing screen
├── dashboard.html          Main app (Overview, Story, Issues, System Map tabs) + import dialog
├── css/
│   ├── main.css            Design tokens, reset and base element styles
│   ├── layout.css          App shell: sidebar, navigation, topbar, page framing
│   ├── components.css      Reusable UI: tabs, cards, buttons, code panels, pills
│   └── pages/
│       ├── dashboard.css   Page styles for Overview, Issues and System Map
│       ├── splash.css      Splash screen styles
│       ├── import.css      Import dialog styles
│       ├── workspace.css   My Projects, My Explorer and Settings styles
│       └── story-visuals.css Story diagrams, workflow timeline and code panels
├── js/
│   ├── main.js             App-level wiring: shortcuts, project selector, search
│   ├── components/
│   │   ├── ui.js           Escaping, formatting and the markdown renderer
│   │   ├── api.js          Client for the local backend
│   │   ├── store.js        localStorage: selected project and UI prefs
│   │   ├── sidebar.js      Sidebar toggle and view navigation
│   │   ├── buttons.js      Chapter / step / pill selection and prev-next nav
│   │   └── diagrams.js     SVG graph, code panel and highlighter for Story visuals
│   └── pages/
│       ├── dashboard.js    Section tab switching and the System Map view
│       ├── import.js       Import dialog: methods, file collection, validation
│       ├── views.js        Top-level view switching (Home ↔ workspace)
│       ├── projects.js     My Projects view
│       ├── story-visuals.js Story Visual guide and per-chapter visuals
│       ├── explorer.js     My Explorer view (story / map / issues)
│       └── settings.js     Settings view
├── backend/
│   ├── main.py             FastAPI app (import, projects, analysis, AI, settings)
│   ├── analyzer.py         Import validation, exclusions and limits
│   ├── store.py            On-disk project store (backend/data/)
│   ├── static_analysis.py  System map and issue detection
│   ├── ollama.py           Minimal stdlib Ollama client
│   └── requirements.txt    Python dependencies
├── simple-pos-demo/        Built-in demo project (reviewed via GET /api/demo)
│   ├── index.html          POS page
│   ├── README.md           Demo documentation
│   ├── css/style.css       Demo styles
│   └── js/                 products.js, cart.js, app.js
└── README.md
```

## Backend API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Service health check. |
| GET | `/api/demo` | Return the built-in demo project's file list and contents (for review before analysis). |
| POST | `/api/import/zip` | Validate and store a `.zip` upload (multipart `file`, `source`). |
| POST | `/api/import/files` | Validate and store uploaded files (multipart `files[]`, `paths`, `project_name`, `source`). |
| POST | `/api/import/snippet` | Validate and store a pasted snippet (`filename`, `content`, `project_name`, `source`). |
| GET | `/api/projects` | List stored projects. |
| GET | `/api/projects/{id}` | Get one project's metadata. |
| DELETE | `/api/projects/{id}` | Delete a project and its stored files. |
| GET | `/api/projects/{id}/file?path=` | Read one stored file's text. |
| POST | `/api/projects/{id}/reanalyze` | Re-run validation over the stored files. |
| GET | `/api/projects/{id}/map` | Build the import relationship graph. |
| GET | `/api/projects/{id}/issues` | Run static checks and return findings. |
| GET | `/api/projects/{id}/visuals` | Static diagram data for the Story: file architecture, JS call graph, event entry points and (for point-of-sale projects) the traced checkout workflow. |
| GET | `/api/projects/{id}/story` | Read the cached story (if any). |
| POST | `/api/projects/{id}/story` | Generate a story with local Ollama (`503` when unavailable). |
| GET | `/api/ai/status` | Real Ollama connection status. |
| GET / PUT | `/api/settings` | Read / update Ollama host, model and analysis preferences. |
| DELETE | `/api/data` | Clear all stored projects and settings. |

## Conventions

- **No frameworks, bundlers or package managers** on the front end. Plain
  HTML, CSS and JavaScript.
- Scripts are classic (non-module) and load in dependency order from
  `dashboard.html`: `ui.js` → `api.js` → `store.js` → `sidebar.js` →
  `buttons.js` → `diagrams.js` → `dashboard.js` → `import.js` → `views.js` →
  `projects.js` → `story-visuals.js` → `explorer.js` → `settings.js` → `main.js`.
- Stylesheets load in specificity order:
  `main.css` → `layout.css` → `components.css` → `pages/dashboard.css` →
  `pages/import.css` → `pages/workspace.css` → `pages/story-visuals.css`.
- Keep page-specific CSS/JS inside the matching `pages/` folders and shared
  code at the top level of `css/` and `js/`.

## Notes

- `story.html`, `issues.html` and `system-map.html` are **not** separate pages:
  they live as panels inside `dashboard.html` and switch via the section tabs.
- No `assets/` folder is included because the app uses inline SVG icons, so
  there are no local asset files to store.

## Story visuals

The My Explorer Story adds a collapsible **Visual guide** (architecture and
workflow diagrams), one visual per chapter (module diagram, workflow segment,
data flow, call diagram or findings summary) and dark code panels with real
line numbers beside each chapter's text. The data comes from
`backend/visuals.py`, which reads the stored files as text:

- File links reuse `static_analysis.build_map`, plus the names each import brings in.
- Function links come from JavaScript call sites, `new` expressions and
  `addEventListener` handlers. Dynamic dispatch and other languages are not traced.
- Workflow transitions are marked *Inferred* when no call or wired listener links two stages.
- Likely secrets are redacted from every snippet.

Backend tests: `cd backend && python -m unittest discover tests`.
