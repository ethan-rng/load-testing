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

Check your setup before a run:

```
npm run check:env                # validates .env and the shell
npm run check:env -- --online    # also tries the target, the app map and the test login
```

Find the load that Vercel refuses, then check the allow rule fixes it (dev only):

```
npm run check:waf -- --preset=poll-500 --expect=blocked   # 1. find the refusal point
# 2. allow this machine's IP in Vercel and wait for the rule to publish
npm run check:waf -- --preset=poll-500                    # 3. same load, nothing refused
```

Presets (one "user" polls every few seconds, like a live widget):
`light` (20 req/s, 2 min), `poll-500` (500 users, 250 req/s, 5 min),
`poll-500-fast` (500 req/s, 5 min), `burst` (1000 req/s, 1 min). It ramps up,
holds the full rate, and stops at the first refusal. Or set `--users`,
`--interval` and `--hold` yourself, or plain `--steps=5,20,50 --seconds=5`.
`--path` picks the endpoint (default `/api/auth/csrf`, which is cheap).

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

## Web UI (local for now)

```
npm run server        # then open http://127.0.0.1:8080
```

A page to launch a run, watch its log live, stop it, and open past reports.
Launch values are checked on the server: target must be in `ALLOWED_TARGETS`
(production is refused at startup), at most 500 users and 10 minutes, one run
at a time, mutations can't be turned on. Only a few settings reach k6, so
server secrets never do. If the server stops, it stops the active run, and on
restart it cleans up any run left behind.

### Profiles (simulated users)

A profile is one recorded session: an ordered list of tRPC calls with the wait
before each. The Profiles page generates them from a D1 export, and you can then
edit steps and waits, set a weight (higher is picked more often), enable or
disable, duplicate, or delete them. **Publish to k6** writes the enabled ones to
`data/profile.<phase>.json`, which the realistic mode will read (not built yet).

Getting data in: D1 exports as SQL, so convert it to a SQLite file and upload it
on the page (or drop it in `data/imports/`):

```
wrangler d1 export <database> --remote --output=d1.sql
sqlite3 d1.db < d1.sql
```

No D1 yet? `npm run sample:d1` writes a fake export to `data/imports/` to try it.

Generation splits each user's calls into sessions wherever they go quiet (30 min
by default), skips failed calls, writes and anything on the never-call list
(`src/lib/denylist.ts`), shortens very long waits, and takes a random sample if
there are more sessions than you asked for. User hashes and timestamps are used
to build sessions and are not stored; only the order of calls and the gaps
between them are kept. Profiles live in `data/profiles.db` (SQLite, via Node's
built-in `node:sqlite`, which Node still labels experimental).

### Code page

Read-only view of this project's source, so people can see what a run does. Only
source folders and a few root files can be opened. `.env`, `data/`, `results/`,
`node_modules` and `.git` are not reachable, and symlinks can't be used to get
around that. There's deliberately no editing: that would let anyone who can
launch runs execute their own code on the server.

### Sign-in (GitHub, hackwestern org)

Set `AUTH_MODE=github` for anything other than your own laptop. Only active
members of the `GITHUB_ORG` can open the page. Members of `LAUNCH_TEAM` can
launch and stop runs; everyone else in the org can view. There is no default
launch team: the server won't start without one.

Setup:
1. GitHub > Settings > Developer settings > OAuth Apps > New. Homepage URL is
   `PUBLIC_URL`; callback URL is `PUBLIC_URL/auth/callback`. If the org restricts
   third-party apps, an org owner has to approve it.
2. Put the client id and secret, `PUBLIC_URL`, `LAUNCH_TEAM` and a random
   `SESSION_SECRET` in `.env` (see `.env.example`).

The app asks GitHub for `read:org` to check membership, then throws the GitHub
token away. The session is a signed cookie (`SESSION_HOURS`, default 4), so
removing someone from the org takes effect when their session ends. At most 10
launches per person per hour.

`AUTH_MODE=none` is for local use: no login, and the server only binds to
127.0.0.1.

## Safety

- Refuses `hackwestern.com`, and any host not in `ALLOWED_HOSTS`
  (default `dev.hackwestern.com`; localhost is always allowed).
- Mutations are off unless `ALLOW_MUTATIONS=true`.
- Routes that send email, call GitHub/Devpost, or delete data are on a
  deny-list in `src/lib/config.ts`.

## Check

```
npm run typecheck
npm test         # launch guardrails and the sign-in flow (against a fake GitHub)
npm run mock     # fake app on :3999 for trying the scripts without the real one
```

The Rust version of this tool is in git history (commit `e651385`).
