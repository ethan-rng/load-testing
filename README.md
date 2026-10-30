# load-testing

Load tests one tRPC route of the Hack Western site with fake payloads. Each
virtual user optionally logs in as a seeded test user, then sends requests
back to back until the time is up and reports throughput, latency
percentiles and status codes.

Rust port of the k6 setup Lucas (hackwestern/hackwestern#746) and Ethan
(`load-testing` branch) built in
[hackwestern/hackwestern](https://github.com/hackwestern/hackwestern).

## Run

```
cargo run --release -- --route application.get --vus 10 --duration 30s
```

| Flag | Default | |
| --- | --- | --- |
| `--route` | | tRPC route, e.g. `application.get` |
| `--auth` | `none` | `none`, `hacker` or `organizer` (`n`/`y`/`o` also work) |
| `--vus` | `10` | concurrent virtual users |
| `--duration` | `30s` | e.g. `30s`, `2m` |
| `--url` | `http://localhost:3000` | base URL of the deployment |
| `--schema` | `api.json` | OpenAPI export of the tRPC router |

With `--auth hacker` or `--auth organizer`, one test user per virtual user is
inserted into `DATABASE_URL` before the run and deleted after it, including on
Ctrl-C. `DATABASE_URL` has to be the database the target deployment uses.

```
DATABASE_URL=postgres://... cargo run --release -- --route application.get --auth hacker --url http://localhost:3000
```

## Targets

- Local dev server: default.
- The dev preview (`https://hackwestern-git-dev-hack-western-web.vercel.app`)
  uses the dev database. Vercel's DDoS mitigation will block sustained load
  from one IP unless that IP has a system bypass rule; ask the web lead.
- Never production.

## Schema

`api.json` is the OpenAPI export from the main repo's `/api/openapi` route
(`trpc-to-openapi`, only on the `load-testing` branch). The copy here is from
September and is behind `dev`, so some payloads get 400s. Regenerate it when
the routers change.

Fields named `email` and `password` get hand-written values that pass the
sign-up rules; everything else is generated from the schema.

## Test

```
cargo test
```

Checks that fake payloads for every route in `api.json` validate against
that route's input schema.
