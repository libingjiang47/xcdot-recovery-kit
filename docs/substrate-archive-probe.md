# Historical Substrate archive probe

`probe-substrate-archive` is a diagnostic-only capability test. It never calls Ethereum JSON-RPC
and never changes the v0.26 reconstruction or canonical snapshot paths. It pins the known Moonbeam
block `16796696` and tests, in order:

1. `chain_getHeader`
2. `state_getRuntimeVersion`
3. `state_getMetadata`
4. `state_getStorage(0x3a636f6465, blockHash)` for the `:code` key
5. `state_getReadProof([0x3a636f6465], blockHash)`

The header must contain block number `16796696` and state root
`0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`. Runtime `specVersion` 4401
and `stateVersion` 1 are also required. The endpoint is classified as `HISTORICAL_STORAGE` only
after methods 1–4 pass. `HISTORICAL_PROOF` additionally requires the existing Rust trie verifier to
verify the returned proof against the pinned state root.

## Single provider

```bash
node dist/cli/index.js probe-substrate-archive \
  --provider-name onfinality \
  --rpc wss://moonbeam.api.onfinality.io/public-ws \
  --block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
```

The default timeout is 15 seconds and the default retry count is 3. Reports are written below
`diagnostics/substrate-archive-probe/` unless `--out` specifies an exact provider directory. URLs
are never written to reports; only scheme, host, and credential presence are retained.

## Provider matrix

```bash
node dist/cli/index.js probe-substrate-archive-matrix \
  --block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f \
  --provider onfinality=wss://moonbeam.api.onfinality.io/public-ws \
  --provider foundation=wss://wss.api.moonbeam.network \
  --provider unitedbloc=wss://moonbeam.unitedbloc.com
```

Without explicit `--provider` values, the matrix uses the known OnFinality, Foundation, and
UnitedBloc Substrate endpoints and reads optional credentials from
`MOONBEAM_SUBSTRATE_RPC_1RPC`, `MOONBEAM_SUBSTRATE_RPC_DWELLIR`,
`MOONBEAM_SUBSTRATE_RPC_DRPC`, and `MOONBEAM_SUBSTRATE_RPC_PUBLICNODE`. An unset variable is
reported as `NO_KNOWN_SUBSTRATE_ENDPOINT`; an EVM URL is never inferred as a Substrate URL.

Each provider receives `report.txt`, method artifacts, and `offline-proof.json`. The matrix writes
`matrix-summary.json` and continues after an individual provider fails. A successful historical
storage provider is enough to proceed with the next reconstruction milestone; a successful
historical proof provider is enough to proceed with proof acquisition.
