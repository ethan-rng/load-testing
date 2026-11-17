# load-testing

k6 load tests (TypeScript) for the Hack Western site. Two modes:

- `naive`: a fixed, read-only loop of routes. Works today.
- `realistic`: user behavior shaped by D1 request data, per phase
  (`before`, `during`, `after`). Not built yet.

## Run

```
npm install
TARGET=http://localhost:3000 TEST_EMAIL=you@example.com TEST_PASSWORD='...' \
  VUS=10 DURATION=60s ./run.sh
```

Settings can go in a `.env` file (copy `.env.example`; `.env` is gitignored).
`run.sh` and `npm run fetch:app-map` both read it, and values set in the shell
override it. Settings are env vars: `TARGET`, `MODE` (default `naive`), `PHASE` (default
`during`), `VUS`, `DURATION`, `RAMP_UP`, `ALLOW_MUTATIONS`, `TEST_EMAIL`,
`TEST_PASSWORD`, `ALLOWED_HOSTS`.

Each run writes `results/<testid>.json` (and an HTML report for longer runs).

## App map

At the start of each run, `setup()` fetches the app map from
`DOCS_ROOT/api/docs/app` using the bearer token in `DOCS_TOKEN`. `DOCS_ROOT`
defaults to `TARGET`. It checks that the scenario's routes still exist with
the right type and warns about any that don't.

If the runtime fetch fails or there's no token, it falls back to a saved copy
at `data/app.json` (gitignored) and says so in the log. With neither, naive
mode still runs, with no route check. Treat the file as a fallback only.

To refresh the saved copy:

```
DOCS_ROOT=https://hackwestern.com DOCS_TOKEN=... npm run fetch:app-map
```

(`api.json` at the root is the older OpenAPI export and isn't used.)

## Safety

- Refuses `hackwestern.com`, and any host not in `ALLOWED_HOSTS`
  (default `dev.hackwestern.com`; localhost is always allowed).
- Mutations are off unless `ALLOW_MUTATIONS=true`.
- Routes that send email, call GitHub/Devpost, or delete data are on a
  deny-list in `src/lib/config.ts`.

## Check

```
npm run typecheck
npm run mock     # fake app on :3999 for trying the scripts without the real one
```

The Rust version of this tool is in git history (commit `e651385`).
