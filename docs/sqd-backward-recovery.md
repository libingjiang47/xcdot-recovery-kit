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
  --window-blocks 100000 \
  --max-empty-windows 10 \
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

Persistence advances the backward cursor only after balances, positive proof captures,
candidate membership, round result, and summary are durable. Resume reuses those files and
repairs proof gaps without re-reading an already cached balance. The proof files are evidence
only: this command deliberately does not invoke the Rust verifier, does not verify trie roots,
and never publishes a `VERIFIED` snapshot.

An empty window means that it discovered no previously unknown address, not that it contained
no Transfer logs. Ten consecutive empty windows produce `BACKWARD_DISCOVERY_STALLED`; reaching
genesis with a positive deficit produces `REACHED_GENESIS_WITH_SHORTFALL`. If the known final
balances equal total supply, the command stops immediately with `SUPPLY_COMPLETE`, because all
balances are non-negative. That is a supply-completeness result, not cryptographic proof
verification.
