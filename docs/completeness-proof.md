# Completeness boundary

For the legacy Assets backend, the evidence bundle retains every enumerated
`Assets.Account[xcDOT]` storage key before decoding. The traversal requires strictly increasing
keys, no duplicates, advancing pagination, a matching asset account count, and a supply sum that
matches the raw `AssetDetails` supply.

Every retained key, including `AssetDetails`, metadata, and optional runtime code, is covered by
one deterministic read proof. The offline verifier checks those proofs against the header state
root before using any decoded balance. This prevents an RPC response from silently replacing a
raw value or omitting a positive balance while still passing the supply invariant.

This theorem does not apply to EVM contract storage merely because its slots can be enumerated.
Without a proven mapping from balance slots to all H160 holders, the current EVM-backed runtime
is reported as unsupported rather than treated as a complete snapshot.
