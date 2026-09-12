# Dwellir direct final-state probe

`probe-dwellir-final-state-direct` is the minimal live capability test for the
Dwellir Moonbeam endpoint. It uses `curl` and sends only these requests, in
order:

1. `state_getStorage([0x3a636f6465, blockHash])`
2. `state_getReadProof([[0x3a636f6465], blockHash])`

It does not call `chain_getHeader`, runtime methods, EVM methods, Subscan, or
any holder/extraction workflow.

The pinned block is `16796696`:

```text
0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
```

The expected state root is:

```text
0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
```

Run from WSL after putting `DWELLIR_KEY=...` in the local ignored `.key`:

```bash
set -a
source .key
set +a
node dist/cli/index.js probe-dwellir-final-state-direct
```

The key is used only in the endpoint path and is never printed, committed, or
written to diagnostics. Output is written to
`diagnostics/dwellir-final-state-direct-probe/`. The `report.txt` file records
only runtime-code length and SHA-256, not the full runtime value. A returned
read proof is checked offline with the existing Rust proof verifier against
the pinned state root and state version 1.
