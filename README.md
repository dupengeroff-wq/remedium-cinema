# REMEDIUM CINEMA — Stage 3 critical fixes

Existing Node.js / Express / Socket.IO / PostgreSQL application based on the approved Stage 2 structure. **READY FOR REVIEW**, not a production-ready release or deployment instruction. Stage 1 and 2 were approved; Stage 4 has not started.

## Structure
- `server.js`: stable entry; `src/server/`: HTTP, realtime, DB, domain modules.
- `public/`: two original HTML shells, classic browser scripts, styles and original image assets.
- `lib/` and `media.js`: compatibility ESM facades.
- `migrations/`: historical 001–010 preserved byte-for-byte; 011 changes only future profile theme default to `none`.
- `test/`: integration suite (requires lockfile dependencies) and dependency-free Stage2/3 regression tests.
- `docs/`: reports, approved baseline, blocked checks and decisions.

## Local checks (no database or network)
Node >=22; use the exact lockfile. Current verified environment: see `docs/TEST_ENVIRONMENT.md`.
```sh
npm run check
npm run test:structure
npm run test:stage3
```

## Isolated integration environment only
Do **not** start this version against existing real data. `npm start` and `/ready` no longer apply migrations; incomplete schema results in failed readiness/DB-dependent requests. Production schema upgrade is **not authorized**, and the migration CLI in this package only accepts an explicitly opted-in loopback test DB. No tunnels/proxies to external databases.

After an approved, separate local disposable environment has the locked dependencies:
```sh
npm ci
npm test
```
The integration test initializes its own PGlite loopback, creates synthetic fixtures and explicitly runs the migration CLI. For additional manual tests, follow `docs/STAGE3_BLOCKED_EXECUTION_PLAN.md`. Never pass production secrets or real user data.

Legacy instructions in `docs/legacy` are historical and not authorization for deployment. **Do not overlay archive files on the deployed app.** The future release process and schema readiness gates will require separate approval.
