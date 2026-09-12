# Rank 565 diagnostic

This investigation is deliberately separate from `import-subscan`. The source CSV files remain
untouched, and the empty `Account` at Rank 565 continues to produce `SUBSCAN_INVALID_ADDRESS` in
the production importer.

The diagnostic is pinned to Moonbeam block `16796696`, xcDOT contract
`0xffffffff1fcacbd218edc0eba20fc2308c778080`, and missing balance `143274324851` planck.
It does not query `latest`.

## Run

Use an archive-capable Moonbeam EVM JSON-RPC endpoint:

```bash
node dist/cli/index.js diagnose-rank565 \
  --dataset snapshots/subscan \
  --evm-rpc <moonbeam-evm-rpc> \
  --block-number 16796696 \
  --out diagnostics/rank565
```

The command performs the phases in order:

1. verify the pinned block, contract code, `symbol`, and `decimals`;
2. query `balanceOf(0x0000000000000000000000000000000000000000)`;
3. query `totalSupply` and compare the known deduplicated Subscan total;
4. query all valid unique Subscan addresses at the pinned state;
5. scan `Transfer` history only after a justified `--from-block` is supplied;
6. query every Transfer-history address absent from the valid Subscan set;
7. accept a recovery only when exactly one address has the missing balance and supply equality
   closes exactly.

The older diagnostic's Subscan-total comparison is retained for historical investigation only. It
is not a gate for v0.26 final-state reconstruction. See the [arithmetic erratum](rank565-arithmetic-erratum.md)
for the corrected Rank-565-adjusted diagnostic total.

`--from-block` is intentionally required before the multi-million-block scan. It prevents a
transient RPC failure during D0–D5 from silently starting a scan from block zero. The scan begins
with 10,000-block ranges, halves a rejected range, persists every successful range, and supports
`--resume`.

All diagnostic evidence is non-canonical and is written below `diagnostics/rank565/`. The raw
Subscan files are never rewritten. A `snapshots/subscan/resolutions/rank-565.json` file is created
only after the final balance, non-zero H160, and total-supply checks all pass.

## Evidence files

- `dataset-audit.json` records the raw row counts, digest, duplicate arithmetic, and exact invalid
  Rank 565 row.
- `zero-address.json`, `contract-state.json`, and `supply-comparison.json` record pinned EVM
  state evidence.
- `known-final-balances.ndjson` and `unknown-positive-balances.ndjson` record final-state query
  results.
- `transfer-scan-summary.json` records every successful log range and the observed coverage
  relationship between Transfer addresses and the known holder set.
- `candidate-resolution.json` is `RESOLVED` only if a unique address closes totalSupply; it is
  otherwise `UNRESOLVED` and contains no fabricated address.
- `SHA256SUMS` covers the deterministic evidence files; resumable checkpoints under `work/` are
  intentionally excluded.

`MIGRATION_TRANSFER_ENUMERATION_COMPLETE=YES` means the completed scan covers every known valid
Subscan address from its selected start block. This is an empirical coverage result, not a claim
that an unreviewed migration implementation emitted every historical event. If a known holder is
absent from the event universe, the command reports `NO` and stops before candidate recovery.

## First real-run record

On this WSL host, both the Moonbeam Foundation endpoint
`https://rpc.api.moonbeam.network` and the independent OnFinality endpoint
`https://moonbeam.api.onfinality.io/public` failed at the initial historical EVM `eth_chainId`
request with `fetch failed`. The exact Viem errors are preserved in the corresponding diagnostic
`report.txt` files.

The public HTTP endpoint `https://1rpc.io/glmr` did return the pinned historical block and passed
the contract identity checks. It returned `balanceOf(0x0)=0` and
`totalSupply=2334516727484230` planck, but that total is below the deduplicated valid Subscan
sum (`3054649714556639` planck). The diagnostic therefore stopped at C3 before querying known
holders or scanning Transfer history. A subsequent direct historical `balanceOf` request for one
known holder timed out at the RPC connection boundary, so no complete known-final sum is claimed.
The exact 1RPC report is preserved under `diagnostics/rank565-1rpc/`.
