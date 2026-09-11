# Threat model

The primary threats are a malicious or inconsistent RPC, the wrong pinned block, incomplete pagination, incorrect runtime decoding, numeric precision loss, non-deterministic output, and selecting the wrong asset. The mitigations are an explicit block hash, recorded state root and runtime identity, metadata-driven decoding, strict pagination and duplicate checks, BigInt-only quantities, deterministic sorting and serialization, asset ID/symbol/decimals/XC-20 validation, supply reconciliation, and independent EVM checks.

No explorer API, off-chain identity enrichment, private service, private key, or automatic beneficiary inference is used. Multiple independent providers are required before a snapshot is proposed as canonical. Public RPCs can still lie; provider agreement is evidence for review, not a cryptographic replacement for chain consensus.
