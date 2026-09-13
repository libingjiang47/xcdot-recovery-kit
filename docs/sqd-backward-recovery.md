# SQD backward incremental recovery

`recover-sqd-backward` extends the existing Subscan∪Moonscan candidate set by scanning
xcDOT Transfer participants from the pinned final block toward genesis. Each SQD window is
requested with normal `fromBlock <= toBlock` ordering; only the overall window order is
backward. If SQD returns a partial stream, the next request begins at the last returned
`header.number + 1`.

Run the default recovery with:

```bash
node dist/cli/index.js recover-sqd-backward \
  --dataset snapshots/subscan \
  --moonscan-csv snapshots/moonscan/0xffffffff1fcacbd218edc0eba20fc2308c778080.csv \
  --window-blocks 10000 \
  --max-unproductive-windows 20 \
  --connect-timeout-ms 120000 \
  --timeout-ms 300000 \
  --storage-concurrency 2 \
  --resume
```

Before the first SQD request, the command rebuilds the 7,667-address base universe and loads
the existing pinned final-state cache. It refuses to continue unless the cache reproduces the
base count and `1745914648371586` planck sum. Every newly discovered address is queried at the
fixed Moonbeam final Substrate block only once. Zero balances are cached without a proof;
positive balances receive a raw `state_getReadProof` capture.

The checkpoint directory is `diagnostics/sqd-backward-recovery/` and contains:

```text
context.json
checkpoint.json
known-candidates.ndjson
new-final-balances.ndjson
rounds/
proofs/
summary.json
```

If SQD returns HTTP 204 above its available finalized head, the transport reads
`x-sqd-finalized-head-number`. The recovery then clamps its first backward window to that
head and records `sqdFinalizedHead`, `sqdCoverageGapStart`, `sqdCoverageGapEnd`, and
`sqdCoverageGapBlocks` in `context.json` and `summary.json`. The uncovered gap is not treated
as an empty historical window.

Persistence advances the backward cursor only after balances, positive proof captures,
candidate membership, round result, and summary are durable. Resume reuses those files and
repairs proof gaps without re-reading an already cached balance. The proof files are evidence
only: this command deliberately does not invoke the Rust verifier, does not verify trie roots,
and never publishes a `VERIFIED` snapshot.

A productive recovery window discovers at least one previously unknown address with a positive
balance at the pinned final Moonbeam state. A window with zero final-positive contribution is
unproductive, even when it discovers historical participants. The command records candidate
novelty separately from recovery progress and produces `BACKWARD_DISCOVERY_STALLED` after
`max-unproductive-windows` consecutive unproductive windows. This indicates that the current
backward strategy has found no new final-positive holder in the configured horizon; it does not
prove that SQD is incorrect or that no missing holder exists. Reaching genesis with a positive
deficit produces `REACHED_GENESIS_WITH_SHORTFALL`. If the known final balances equal total supply,
the command stops immediately with `SUPPLY_COMPLETE`, because all balances are non-negative. That
is a supply-completeness result, not cryptographic proof verification.

`--max-empty-windows` remains accepted for compatibility but is deprecated and does not control
the recovery stall decision.

Checkpoint schema 2 stores both `consecutiveNoNewCandidateWindows` and
`consecutiveUnproductiveWindows`. On resume, a schema 1 checkpoint is migrated by reading the
completed round files from the end backward, so a productive round resets only the
unproductive suffix counter; historical candidate-only progress remains diagnostic.
