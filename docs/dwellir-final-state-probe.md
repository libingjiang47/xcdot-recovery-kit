# Dwellir final-state minimal proof probe

`probe-dwellir-final-state` is a diagnostic-only capability test. It sends
exactly three JSON-RPC requests to the Dwellir Moonbeam endpoint:

1. `chain_getHeader([blockHash])`
2. `state_getStorage([0x3a636f6465, blockHash])`
3. `state_getReadProof([[0x3a636f6465], blockHash])`

It does not call runtime metadata, query xcDOT balances, query Subscan, read
EVM storage, replay logs, or create a snapshot.

The pinned state is Moonbeam block `16796696`, with block hash
`0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f` and
state root
`0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`.
The storage probe key is `0x3a636f6465` (`:code`).

Put the credential in the local ignored `.key` file as `DWELLIR_KEY=...`, then
run from WSL:

```bash
set -a
source .key
set +a
node dist/cli/index.js probe-dwellir-final-state
```

The key is used only in the URL path
`https://api-moonbeam.n.dwellir.com/<DWELLIR_KEY>` and is never printed or
written to diagnostics. Diagnostic files are written atomically below
`diagnostics/dwellir-final-state-probe/`:

- `header.json`
- `storage-code.json`
- `read-proof.json`
- `offline-proof-verification.json` when verification is attempted
- `report.txt`

If a proof is returned, the existing Rust verifier checks it offline against
the pinned state root and state version 1. A successful capability result is:

```text
FINAL_HEADER=PASS
HISTORICAL_STORAGE=PASS
READ_PROOF_RPC=PASS
READ_PROOF_OFFLINE_VERIFY=PASS
CAN_RECONSTRUCT_FINAL_STATE=true
CAN_GENERATE_VERIFIABLE_PROOFS=true
STATUS=DWELLIR_HISTORICAL_PROOF_CAPABLE
```
