# SBG Preconstruction Bid Tracker

A full-stack rebuild of the **SBG Preconstruction Bid Tracker** (V20). The
original was a single self-contained HTML file that stored everything in
`localStorage`; this version splits frontend and backend, persists data in
SQLite, and keeps `localStorage` as an offline fallback so the app still works
when the API is down.

## Repository layout

```
sbg-tracker/
├── frontend/                  # Static SPA (HTML + CSS + vanilla JS)
│   ├── index.html             # Entry point, includes <meta name="api-base">
│   ├── css/styles.css         # All styling (lifted from the original <style>)
│   └── js/
│       ├── api.js             # Tiny REST client: getState, putState, CRUD
│       └── app.js             # The application -- tour, board, modals, etc.
├── backend/                   # Express + SQLite REST API
│   ├── src/
│   │   ├── server.js          # HTTP bootstrap, CORS, static serve, error handler
│   │   ├── routes.js          # /api/* router
│   │   ├── models.js          # Data-access layer (better-sqlite3)
│   │   ├── db.js              # Connection + migration runner
│   │   ├── migrate.js         # `npm run migrate`
│   │   └── seed.js            # `npm run seed` (default stages, options, etc.)
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   ├── test/
│   │   └── api.test.js        # node:test + supertest end-to-end suite
│   ├── .env.example
│   ├── package.json
│   └── .gitignore
├── .github/workflows/
│   ├── backend-ci.yml         # install + lint + migrate + test on push
│   ├── frontend-ci.yml        # HTML validate + acorn JS parse check
│   └── pages-deploy.yml       # publishes /frontend to GitHub Pages on main
├── docs/
│   └── architecture.md        # Schema diagram + data-flow notes
├── .gitignore
└── README.md
```

## Stack choices (and why)

**Backend: Node.js 20 + Express + better-sqlite3.**
The frontend is JavaScript, so a Node backend keeps everything in one language
and makes it trivial for anyone touching the UI to also touch the API. Express
is the smallest mainstream Node web framework -- the entire `routes.js` is
~150 lines. `better-sqlite3` is synchronous, very fast for the
single-tenant/small-team workload this app is sized for, and has zero
configuration: the database is just a file. SQLite is the perfect choice for a
preconstruction team's internal tool -- it backs up by copying a single file
and runs anywhere from a developer laptop to a $5 VPS.

**Frontend: vanilla HTML/CSS/JS (no React rewrite).**
The original is one ~44k-line HTML file that's been carefully designed and
tested. Re-implementing it in React would be a multi-week effort with a high
risk of behavior drift. Instead the file is split into `index.html` +
`styles.css` + `app.js`, plus a 100-line `api.js` that adds the backend round
trips. The only behavioral change is that `loadState()` now also pulls from
the API after the first paint, and `saveState()` debounces a `PUT /api/state`
in addition to writing localStorage.

**Sync model: local-first with backend mirror.**
- On boot the UI reads localStorage -> renders immediately -> then asynchronously
  pulls `GET /api/state` and re-renders if the server has data.
- Every `saveState()` writes localStorage synchronously and schedules a
  debounced (500ms) `PUT /api/state` to sync the canonical copy.
- If the API is unreachable, the app keeps working entirely off localStorage --
  this matches the original's offline-friendly behavior and means the backend
  outage never blocks a user.

## Quick start

### Local development (single command)

```bash
cd backend
cp .env.example .env             # optional -- defaults are fine
npm install
npm run migrate                  # creates ./data/sbg-tracker.db
npm run seed                     # seeds default stages, milestones, etc.
npm start                        # serves API at /api/* AND the frontend at /
```

Open http://localhost:3001 in a browser. The Express server serves the
frontend from `../frontend` by default (configurable via `STATIC_DIR`).

### Frontend-only mode (open the file directly)

If you just want the original single-page-app experience with no backend,
open `frontend/index.html` directly in a browser. The API health check will
fail and `api.enabled` flips to false; everything falls back to localStorage.

To explicitly disable backend sync, edit `frontend/index.html`:

```html
<meta name="api-enabled" content="false">
```

### Running tests

```bash
cd backend
npm test
```

Tests use an in-memory SQLite database so they're hermetic and fast (~1s).

## REST API

All endpoints live under `/api`. JSON in, JSON out. CORS allowed origins are
configured via the `CORS_ORIGINS` env var (comma-separated).

| Method | Path                                       | Purpose                                         |
| ------ | ------------------------------------------ | ----------------------------------------------- |
| GET    | `/api/health`                              | Liveness probe                                  |
| GET    | `/api/state`                               | Full assembled frontend state object            |
| PUT    | `/api/state`                               | Replace canonical state (body: `{ state }`)     |
| GET    | `/api/projects`                            | List projects                                   |
| POST   | `/api/projects`                            | Create project                                  |
| GET    | `/api/projects/:id`                        | One project (with nested tasks)                 |
| PATCH  | `/api/projects/:id`                        | Partial update                                  |
| DELETE | `/api/projects/:id`                        | Delete (cascades tasks)                         |
| GET    | `/api/projects/:id/tasks`                  | Tasks for a project                             |
| POST   | `/api/projects/:id/tasks`                  | Create task                                     |
| GET    | `/api/projects/:id/tasks/:taskId`          | One task                                        |
| PATCH  | `/api/projects/:id/tasks/:taskId`          | Partial update                                  |
| DELETE | `/api/projects/:id/tasks/:taskId`          | Delete                                          |
| GET    | `/api/team-members` ... `DELETE /:id`      | CRUD on team roster                             |
| GET/PUT | `/api/stages`                             | List / replace lifecycle stages                 |
| GET    | `/api/templates` ... `DELETE /:id`         | CRUD on task templates                          |
| GET/PUT | `/api/holidays`                           | List / replace holidays                         |
| GET/PUT | `/api/options/ball-in-court`              | Ball-in-Court options                           |
| GET/PUT | `/api/options/csi-divisions`              | CSI Divisions                                   |
| GET/PUT | `/api/options/sources`                    | Bid sources                                     |
| GET/PUT | `/api/options/milestone-types`            | Milestone types                                 |
| GET/PUT/DELETE | `/api/settings/:key`                | Arbitrary key/value (companyLogo, prefs, etc.)  |

The frontend uses the coarse `/api/state` endpoint for everything; the
fine-grained entity endpoints exist for integrations, scripts, and future UI
that needs server-side validation per write.

## CI/CD

Three workflows are wired up in `.github/workflows/`:

- **`backend-ci.yml`** -- runs `npm ci`, `npm run lint`, `npm run migrate`
  (against an in-memory DB), and `npm test` on every push and PR that
  touches `backend/`.
- **`frontend-ci.yml`** -- HTML structural validation + an acorn-based
  syntax check on `app.js` and `api.js`.
- **`pages-deploy.yml`** -- publishes `frontend/` to GitHub Pages on every
  push to `main`. If a repository **variable** named `API_BASE` is set, the
  deployed site points at it; otherwise backend sync is auto-disabled so the
  Pages site works as a pure-localStorage demo.

### Backend hosting on AWS EC2

A complete deploy path is wired up in `deploy/aws/` and
`.github/workflows/backend-deploy.yml`. It targets a free-tier
`t3.micro` instance and auto-deploys on every push to `main`.

Walkthrough: [`docs/aws-setup.md`](docs/aws-setup.md).

Summary:
- `deploy/aws/user-data.sh` -- pasted into EC2 "User data" at launch.
  Installs Node, clones the repo, runs migrations, starts the systemd unit.
- `deploy/aws/sbg-tracker.service` -- systemd unit that runs the backend
  under a dedicated `sbg` user with auto-restart.
- `deploy/aws/Caddyfile` -- optional reverse proxy for free Let's Encrypt HTTPS.
- `.github/workflows/backend-deploy.yml` -- SSHes into EC2 on push and runs
  pull + npm ci + migrate + systemctl restart. Requires three repo secrets
  (`AWS_HOST`, `AWS_USER`, `AWS_SSH_KEY`).

Cost: $0 for 12 months under AWS free tier; ~$8/month afterwards. The same
artifacts work on any Linux host (DigitalOcean, Hetzner, your own server) --
just adapt the SSH details.

## Source attribution

This codebase originates from a single-file HTML/JS application authored by
Source Building Group (`SBG Preconstruction Bid Tracker · V20`, built
2026-04-19). The original was extracted from a Word document and split into
the modular structure above; Word's auto-corrections (smart quotes, en-dashes
in CSS custom-property prefixes, etc.) were reversed during extraction.
