# xcDOT terminal-state recovery snapshot

This repository freezes the known xcDOT state at Moonbeam block `16,796,696`:

- block hash: `0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f`
- Substrate state root: `0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`
- contract: `0xffffffff1fcacbd218edc0eba20fc2308c778080`
- total supply: `2334516727484230` planck (`233451.672748423 xcDOT`)

The frozen dataset contains 11,785 known non-zero address records. Their final
AccountStorages values sum to `2334506800114108` planck, leaving
`9927370122` planck (`0.9927370122 xcDOT`) unattributed. It is therefore a
terminal-state evidence dataset, not a canonical complete holder list. An
address absent from it is not treated as a zero balance.

## Build and verify

Build the deterministic data files from the already captured final balances:

```text
node dist/cli/index.js build-release \
  --source diagnostics/candidate-extension/candidate-cd2e0f20e5d49992/final-balances.ndjson \
  --out data
```

Capture raw Dwellir `state_getStorage` and `state_getReadProof` responses. The
credential is read from the local `.key` file and is never written to data or
metadata:

```text
node dist/cli/index.js capture-release-proofs --data data --resume
```

After capture, the Rust verifier performs all trie checks without network
access:

```text
NO_NETWORK=1 node dist/cli/index.js verify-release --data data
```

The release proof type is `substrate-state_getReadProof`. `eth_getProof` and
explorer balances are not canonical evidence. Once all 11,785 balance proofs
and the total-supply proof pass offline, the release status becomes `READY`.
`READY` freezes the verified known-holder evidence; the remaining
`9927370122` planck is still recorded as an unattributed shortfall, so the
artifact does not claim that the known address set is a complete holder
universe.
