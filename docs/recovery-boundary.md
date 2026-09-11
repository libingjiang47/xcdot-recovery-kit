# Recovery boundary

This repository's snapshot records custody of xcDOT at the Moonbeam state level. It does not decide how contract-held balances should be distributed, whether a claimant is legally or economically entitled to DOT, or what governance mechanism should authorize a recovery.

An externally owned account and a contract are different recovery problems. `eth_getCode` classification is informational: `no_code` does not mathematically prove private-key control, while `has_code` identifies a contract-held balance that may represent an LP position, lending deposit, vault, escrow, bridge, treasury, or multisig. The snapshot must faithfully report all of them and must not transform a contract balance into a beneficiary.

Future ownership proofs and destination binding must be separate artifacts from the historical state snapshot. A future claim tree must be built from an approved recovery dataset, not directly from `holders.ndjson`.
