# v0.26 final-state reconstruction

`reconstruct-final-state` treats the frozen Subscan export as an address-discovery source, not as a
final balance source. It normalizes valid H160 addresses, removes the exact duplicate, excludes the
invalid Rank 565 row, and writes a deterministic address-only digest.

Run it against an archive-capable Moonbeam EVM endpoint at the explicit block:

```bash
node dist/cli/index.js reconstruct-final-state \
  --dataset snapshots/subscan \
  --evm-rpc https://1rpc.io/glmr \
  --block-number 16796696 \
  --expected-total-supply 2334516727484230 \
  --concurrency 1 \
  --delay-ms 100 \
  --retries 5 \
  --resume
```

The preflight requires Moonbeam chain ID 1284, the pinned block, non-empty xcDOT code, `symbol()`
`xcDOT`, `decimals()` 10, zero-address balance zero, and the optional exact total-supply
expectation. Every candidate receives `SUCCESS`, `RPC_ERROR`, or `INVALID_RESULT`. Successful
results are appended to `work/final-state/results.ndjson`; `checkpoint.json` binds the candidate
digest, contract, chain ID, block number, EVM block hash, and total supply. A later `--resume` never
restarts successful addresses and rejects a different pinned context.

The output is non-canonical and is ignored by Git under `snapshots/final-state/`. A complete run
writes the positive-holder, zero-candidate, Subscan-vs-final diagnostic, and summary artifacts below
`evm-rpc/`. The only correctness gate is:

```text
sum(final balanceOf values for all candidates) == totalSupply()
```

`FINAL_STATE_RPC_VERIFIED` means the RPC reconstruction is complete and the equality holds. A
positive delta is `FINAL_STATE_SUPPLY_SHORTFALL`; a negative delta is
`FINAL_STATE_SUPPLY_OVERFLOW`. Neither status is renamed `CANONICAL`.

## Substrate-backed path

The proof-ready backend requires a provenance-bearing layout artifact containing the exact compiler
version, optimizer settings when applicable, source hashes, and Solidity `storageLayout` output.
The tool validates `_balances` as `mapping(address => uint256)` and `_totalSupply` as an aligned
`uint256`; it never assumes slot zero or a fixed pallet index.

```bash
node dist/cli/index.js inspect-evm-storage-layout \
  --substrate-rpc <moonbeam-substrate-rpc> \
  --block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f \
  --layout <verified-layout.json>

node dist/cli/index.js extract-final-state-storage \
  --substrate-rpc <moonbeam-substrate-rpc> \
  --block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f \
  --dataset snapshots/subscan \
  --layout <verified-layout.json>
```

The extractor derives the EVM mapping key with
`keccak256(pad32(address) || pad32(mappingSlot))`, asks runtime metadata to encode
`pallet_evm::AccountStorages`, reads only at the pinned block, and acquires 128-key
`state_getReadProof` batches. It reports `PROOF_READY`; offline trie verification remains a separate
step until the proof-bearing final-state artifact is passed to the verifier.
