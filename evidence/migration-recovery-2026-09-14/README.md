# xcDOT migration-era recovery evidence

This bundle freezes the investigation state observed on 2026-09-14. It is an
evidence package, not a canonical holder snapshot.

The results were produced from code commit `5c99ac7` on branch
`codex/subscan-final-state-probe`. The annotated baseline tag is
`evidence/migration-recovery-v1`.

The evidence hierarchy is:

```text
Subscan / Moonscan / SQD / OnFinality logs
    -> candidate H160 discovery only
Moonbeam pinned Substrate state via Dwellir
    -> final balance reads
state_getReadProof + offline verification
    -> not completed in this phase
```

The migration candidate extension queried 18,429 union addresses successfully.
It reduced the previous shortfall to `9,927,370,122` planck (`0.9927370122`
xcDOT), but did not reach supply completeness. Therefore this bundle is
explicitly:

```text
STATUS = FINAL_STATE_SUPPLY_SHORTFALL
VERIFIED = false
CANONICAL = false
```

The `sources/`, `candidates/`, `final-state/`, and `logs/` directories retain
the local raw and derived artifacts. They are intentionally excluded from the
Git commit because they include large evidence/cache files. The tracked index
files are `manifest.json`, `provenance.json`, `hashes.sha256`, and the
methodology report.

Run `sha256sum -c hashes.sha256` from this directory to verify the local bundle.
The original interactive recovery stdout was not captured as a standalone
file; durable summaries, checkpoints, range results, raw log records, and the
source files are retained instead.
