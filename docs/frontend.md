# Static frontend

The `web/` directory is a static reader for the frozen release. It provides
address lookup, statistics, ranking, multilingual copy, evidence download, and
lazy proof display.

Build it entirely offline:

```bash
NO_NETWORK=1 pnpm web:build
```

The browser requests only files shipped under `web/`; it never calls Moonbeam,
Dwellir, Subscan, SQD, or another RPC/API provider. GitHub Pages publishes the
same static artifact after offline release verification.
