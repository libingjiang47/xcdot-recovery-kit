# Threat model

RPC providers, explorers, and indexers are untrusted. They may be unavailable,
pruned, inconsistent, or incomplete. The release therefore does not accept an
off-chain balance as final evidence.

The pinned Moonbeam state root is the trust anchor. Every published total-supply
and holder balance is checked against that root with a Substrate trie read proof.
Verification is performed locally by the independent Rust verifier, without
network access.

The snapshot describes observed terminal-state balances. It does not establish
asset ownership, private-key control, claim eligibility, or a recovery policy.
