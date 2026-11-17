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

Settings are env vars: `TARGET`, `MODE` (default `naive`), `PHASE` (default
`during`), `VUS`, `DURATION`, `RAMP_UP`, `ALLOW_MUTATIONS`, `TEST_EMAIL`,
`TEST_PASSWORD`, `ALLOWED_HOSTS`.

Each run writes `results/<testid>.json` (and an HTML report for longer runs).

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
