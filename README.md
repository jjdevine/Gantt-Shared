# Gantt Task Planner (shared)

A single-page Gantt planner whose state lives in this repository rather than
in each user's browser. See [docs/shared-state-proposal.md](docs/shared-state-proposal.md)
for the design and rollout plan.

## Using it

1. Be a collaborator on this repository.
2. Create a GitHub personal access token that can read and write this
   repository's contents (the repository owner can use a fine-grained token
   scoped to this repo; collaborators use a classic token with `repo` scope).
3. Open the app (GitHub Pages URL, or `index.html` from a clone), open
   **Settings**, paste the token, click **Test connection**, then **Save**.

Every edit is committed to `data/people/<person>.json` on `main`. The page
refreshes from the repository every few minutes and whenever it regains focus.

## Local-only mode

Delete `config.js` and the app behaves exactly like the original: state in
`localStorage`, no repository involved.

## Tests

`npm install` once, then `npm test`. This runs `test/harness.mjs`, which loads
`index.html` in jsdom against an in-memory mock of the GitHub Contents API and
exercises load, save, refresh, both conflict resolutions, delete, read-only,
offline recovery, local-only mode, first-run settings and migration.
