# Moonscan final-state candidate reconciliation

`recover-dwellir-final-state --moonscan-csv` extends the frozen Subscan candidate set with
Moonscan addresses. Moonscan balances are diagnostic only; final balances are read from the pinned
Moonbeam `pallet_evm::AccountStorages` state.

The command reuses the existing Dwellir storage batches under
`diagnostics/dwellir-final-state-recovery-work/moonbeam-16796696/storage-batches/`. Only addresses
not present in that cache are sent to Dwellir. The extension checkpoint binds the block, state root,
contract, candidate digest, source digest, and total supply. Conflicting cached values stop the run.

```sh
node dist/cli/index.js recover-dwellir-final-state \
  --dataset snapshots/subscan \
  --moonscan-csv snapshots/moonscan/0xffffffff1fcacbd218edc0eba20fc2308c778080.csv \
  --expected-total-supply 2334516727484230 \
  --connect-timeout-ms 120000 \
  --timeout-ms 300000 \
  --storage-concurrency 2 \
  --resume
```

For the frozen evidence this produces a 7,667-address union: 7,288 Subscan candidates, 1,595
Moonscan rows, 1,216 overlapping addresses, and 379 Moonscan-only addresses. The generated
`diagnostics/moonscan-diff/` files include address provenance and Subscan-vs-Moonscan diagnostics;
historical balances in those files never affect supply completeness.

The final artifact is published only after all raw storage values, read proofs, and offline
verification pass. A shortfall or RPC interruption remains diagnostic and does not produce a
canonical snapshot.
