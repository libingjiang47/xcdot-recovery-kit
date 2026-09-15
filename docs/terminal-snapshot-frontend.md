# xcDOT terminal snapshot frontend

The `web/` directory is a static reader for the frozen release data in `data/`.
It has three routes:

- `/` — single-address lookup and snapshot summary;
- `/statistics` — address-type, distribution, and concentration statistics;
- `/top` — ranked known non-zero holders with type filters and pagination.

Build the deployable static data with:

```bash
pnpm web:build
```

The build fails unless the frozen holder count, integer balance sums, total supply,
and every holder-to-proof index entry match the release constants. It writes the
derived static assets under `web/data/` and a `web/404.html` fallback for hosts
that use a static 404 page to serve history-based routes.

The browser only requests static JSON, JSONL, CSV, and proof bundle files. It never
contacts Moonbeam, Dwellir, Subscan, SQD, or another runtime API. Proof bundles are
loaded only for the address currently being inspected; the browser does not verify
tries. The `Verified` label reflects the release verifier's offline result.
