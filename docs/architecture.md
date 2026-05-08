# Architecture notes

## Data model overview

The original application kept a single deeply-nested `state` object in
`localStorage` under the key `sbg_precon_tracker_v3`. The backend mirrors this
shape using two layers:

1. **Normalized tables** for the entities the application iterates over most:
   - `projects` (id, name, client, location, status, archived, start_date, due_date, data)
   - `tasks` (id, project_id FK, title, stage, category, priority, status, dates,
     assignee, source, notes, data)
   - `team_members`, `stages`, `task_templates`, `holidays`,
     `ball_in_court_options`, `csi_divisions`, `source_options`, `milestone_types`
2. **Key/value store** (`key_value`) for everything else -- toggles, view
   modes, filters, the `tour` substate, the company logo, etc. The frontend's
   full state blob is stored here under the key `state` so any field that
   isn't promoted to a typed column round-trips losslessly.

A `data` JSON column on every entity table absorbs schema-less extension
fields (deliverables, checklists, color overrides, etc.) -- this lets the
frontend evolve without forcing a migration for every new field.

## Sync model

```
        Browser                              Server
   ┌─────────────────┐                  ┌──────────────┐
   │  state (in JS)  │  GET /api/state  │              │
   │  ───────────────│ <───────────────►│  SQLite      │
   │  localStorage   │  PUT /api/state  │  (state +    │
   │  (cache/offline)│  (debounced 500ms)│  normalized)│
   └─────────────────┘                  └──────────────┘
```

- **Boot**: render from `localStorage` -> async `GET /api/state` -> if newer,
  replace state and re-render.
- **Mutation**: every UI action writes to `localStorage` synchronously and
  schedules a debounced `PUT /api/state`. Failed PUTs are logged and dropped
  (the next saveState retries).
- **Offline**: `api.enabled` is gated by a successful `GET /api/health`. When
  offline, all writes still hit `localStorage` so the user keeps working.

## CRUD endpoints

The fine-grained endpoints exist for callers who need atomic single-entity
writes (scripts, future UI features, integrations). The frontend itself
currently only uses the coarse state-blob endpoint -- migrating it to
fine-grained writes is straightforward but unnecessary for v1.

## Migrations

`backend/migrations/*.sql` files are executed in lexicographic order by
`runMigrations()` in `db.js`. A `schema_migrations` table tracks which files
have been applied, so the runner is idempotent and safe to invoke on every
boot.
