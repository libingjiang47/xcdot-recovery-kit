# Subscan final-state verification

`verify-subscan-final-state` verifies the Subscan-derived candidate addresses against the xcDOT ERC-20 contract through EVM JSON-RPC. The command uses the exact requested EVM block number for `eth_getBlockByNumber`, `eth_getCode`, `symbol`, `decimals`, `totalSupply`, and every `balanceOf` call. It never falls back to `latest`, `finalized`, or `safe`.

The Substrate block hash is recorded as independent context. Moonbeam's EVM/Frontier block hash is recorded separately; the two hashes are not equated by this tool.

The contract must have non-empty runtime code at the pinned block, report `symbol() == xcDOT`, and report `decimals() == 10`. Runtime code size and keccak-256 are included in the report. Every candidate address is queried with exact integer results. Requests use bounded concurrency (default 4, maximum 16) and at most five exponential retries for errors identified as transient.

Progress is checkpointed under `snapshots/subscan/work/`. A checkpoint can be reused only when candidate digest, contract, block number, and chain ID all match. RPC failures are retained as `RPC_ERROR`; a run with unresolved calls is `INCOMPLETE`.

Positive final balances are sorted into `final-state/holders.ndjson`. `subscan-diff.ndjson` records balance differences and zero-at-final candidates. The final completeness check is exact:

```text
sum(balanceOf(candidate_i)) == totalSupply()
```

Only this RPC-level check can produce `FINAL_STATE_RPC_VERIFIED`. It is not a cryptographic storage proof; the later proof milestone must derive ERC-20 storage slots and verify them against the Moonbeam state root.

Example:

```bash
node dist/cli/index.js verify-subscan-final-state \
  --dataset snapshots/subscan/derived \
  --evm-rpc https://rpc.api.moonbeam.network \
  --block-number 16796696 \
  --substrate-block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
```
