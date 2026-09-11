# Real-world validation log

This log records the first live attempt against the pinned candidate block. It is diagnostic
evidence only; it does not declare the block canonical and contains no generated snapshot.

Pinned candidate:

```text
number = 16796696
hash = 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
stateRoot = 0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
specVersion = 4401
stateVersion = 1
```

The OnFinality probe completed with:

```json
{
  "reachable": true,
  "chain": "Moonbeam",
  "systemName": "Moonbeam Parachain Collator",
  "systemVersion": "0.52.3-dd58b13e70d",
  "finalizedHead": "0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f",
  "finalizedNumber": "16796696",
  "stateRoot": "0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb",
  "specName": "moonbeam",
  "specVersion": 4401,
  "transactionVersion": 3,
  "stateVersion": 1,
  "supportsStorageEnumeration": true
}
```

The Foundation and UnitedBloc probe attempts used the requested endpoints and timed out with
exit code `124` during this run. There is therefore no two-provider equality claim in this log.

The required E0 OnFinality inspect attempt returned exactly:

```text
ASSET_NOT_FOUND: The Assets pallet or required storage queries are unavailable.
```

The no-EVM snapshot attempt returned the same exact error and published no directory. The v0.2
evidence capture attempt now fails earlier and more specifically:

```text
EVIDENCE_BACKEND_UNSUPPORTED: Pinned runtime does not expose the proof-complete legacy Assets backend; asset-like query namespaces: evmForeignAssets. EvmForeignAssets is an EVM-backed registry and does not by itself enumerate complete H160 holder balances.
```

This is an expected fail-closed result for the observed runtime shape. The implementation does
not infer holders from EVM storage slots, relax the supply/account-count checks, or publish a
candidate bundle from incomplete data.
