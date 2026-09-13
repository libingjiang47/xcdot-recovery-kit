# Dwellir Frontier gap recovery

`recover-dwellir-gap` is a deliberately narrow recovery stage. It scans only the
Frontier log range that SQD did not cover, from the pinned final block backwards.
It is separate from `recover-sqd-backward` and does not continue past the
configured gap.

The log provider is independent from the state provider. Before requesting logs,
the configured EVM log endpoint verifies the pinned final EVM block number and
hash. Dwellir is used only for pinned Substrate state reads and read-proof
capture; its optional Frontier sync-range methods are not a log-provider gate.

Transfer participants are candidate addresses only. Their authoritative final
balances are read from Moonbeam's `pallet_evm::AccountStorages` at the pinned
Substrate block. Positive balances receive a `state_getReadProof`; this command
captures proofs but does not run the Rust trie verifier or publish a verified
snapshot. The scan stops early when the known final balance sum reaches total
supply. If the whole gap is scanned with a shortfall, the next priority is
`NON_TRANSFER_BALANCE_INITIALIZATION`.

Recommended run:

```bash
node dist/cli/index.js recover-dwellir-gap \
  --dataset snapshots/subscan \
  --moonscan-csv snapshots/moonscan/0xffffffff1fcacbd218edc0eba20fc2308c778080.csv \
  --prior-work diagnostics/sqd-backward-recovery \
  --gap-start 16669569 \
  --gap-end 16796696 \
  --log-window-blocks 1000 \
  --log-endpoint https://moonbeam.api.onfinality.io/public \
  --connect-timeout-ms 120000 \
  --timeout-ms 300000 \
  --storage-concurrency 2 \
  --resume
```

Evidence and durable checkpoints are written under
`diagnostics/dwellir-gap-recovery/`. Credentials and credential-bearing
endpoints are never written there. A failed range or proof capture leaves the
range uncommitted; rerunning with `--resume` reuses successful balance records
and retries only the missing work.
