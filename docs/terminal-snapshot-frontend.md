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

## Terminal address classification

Address types are captured separately at the pinned Moonbeam EVM block
`16796696`; the classifier never uses `latest`. Active Moonbeam precompiles are
classified as `System` from the pinned runtime set. All other holders are checked
with `eth_getCode` at that block: non-empty code is `Contract`, `0x` is reported as
`EOA` for display, and an unavailable result remains `Unknown`.

Run the capture from WSL with an archive-capable Moonbeam EVM endpoint:

```bash
node dist/cli/index.js classify-release \
  --evm-rpc <moonbeam-evm-rpc> \
  --concurrency 4 \
  --retries 3 \
  --resume
```

Checkpoint and error evidence is kept under `diagnostics/classification/`. The
command resumes only unresolved addresses and refuses to update `data/` while any
holder remains `Unknown`. Consequently `pnpm web:build` also refuses to generate
deployable data until classification completes with zero unknown results.

## Production deployment

Production is published to GitHub Pages by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)
from `main`. The workflow performs deterministic typecheck, lint, format, TypeScript
build, offline release verification, release hash verification, and `pnpm web:build`
before uploading only `web/` as the Pages artifact. It then deploys with the
`github-pages` environment and runs a static smoke test against the deployment URL
provided by GitHub Pages.

The workflow requires no repository secrets and never contacts a chain provider.
Repository-wide tests remain the responsibility of the existing CI workflow; the
Pages workflow does not block publication on the known recovery-test timeouts.
