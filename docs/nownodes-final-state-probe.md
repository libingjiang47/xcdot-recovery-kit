# NOWNodes final-state minimal proof probe

`probe-nownodes-final-state` is a diagnostic-only capability test. It does not
extract xcDOT balances, inspect Solidity storage layout, query Subscan, replay
logs, or create a snapshot.

It uses the pinned Moonbeam Substrate block:

- number: `16796696`
- hash: `0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f`
- expected state root: `0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`
- state version: `1`
- probe key: `0x3a636f6465` (`:code`)

Run it from WSL after putting the credential in the local, ignored `.key`
file as `NOWNODES_KEY=...`:

```bash
set -a
source .key
set +a
node dist/cli/index.js probe-nownodes-final-state
```

The endpoint is `https://moonbeam.nownodes.io/`. Requests use the
`api-key` header and JSON-RPC POST bodies. The key is never printed or written
to diagnostics.

The probe performs only these pinned-state calls, in order:

1. `chain_getHeader([blockHash])`
2. optional `state_getRuntimeVersion([blockHash])`
3. `state_getStorage(["0x3a636f6465", blockHash])`
4. `state_getReadProof([["0x3a636f6465"], blockHash])`

The `:code` value is retained in `storage-code.json` for evidence, while the
human-readable report records only its byte length and SHA-256. If a proof is
returned, the existing Rust verifier checks it offline against the pinned
state root and state version.

Diagnostics are written atomically below:

`diagnostics/nownodes-final-state-probe/`

- `header.json`
- `storage-code.json`
- `read-proof.json`
- `offline-proof-verification.json` when offline verification is attempted
- `report.txt`

The successful stop condition is:

```text
FINAL_HEADER=PASS
HISTORICAL_STORAGE=PASS
READ_PROOF_RPC=PASS
READ_PROOF_OFFLINE_VERIFY=PASS
CAN_RECONSTRUCT_FINAL_STATE=true
CAN_GENERATE_VERIFIABLE_PROOFS=true
STATUS=NOWNODES_HISTORICAL_PROOF_CAPABLE
```

Any failure is preserved as diagnostic evidence. The probe does not weaken
the pinned header, archive-storage, read-proof, or offline-verification gates.
