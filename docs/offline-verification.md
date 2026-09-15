# Offline verification

`verify-evidence` invokes `crates/evidence-verifier` and performs no network operation. The
verifier uses `sp-trie` with `Blake2Hasher` and selects `LayoutV0` or `LayoutV1` from the stored
`runtime.stateVersion`; an unknown state version is an error.

Verification recomputes the SCALE header hash and state root, checks every proof batch against
the pinned root, compares each proven raw value to `state/storage.ndjson`, decodes the legacy
xcDOT supply and account balance fields, reconciles positive balances, checks canonical holders,
and validates file hashes and `evidenceDigest`.

The verifier is intentionally independent of the RPC capture process. A changed holder balance,
raw storage byte, proof node, root, header, metadata, or digest must make the command exit
non-zero.

The frozen terminal-state release uses the same pinned state root through
`NO_NETWORK=1 node dist/cli/index.js verify-release --data data`. It verifies the
totalSupply proof and every known-positive balance proof, while preserving the
explicit unattributed shortfall; passing proof verification does not turn an
incomplete address universe into a canonical holder list.
