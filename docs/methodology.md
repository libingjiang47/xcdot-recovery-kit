# Snapshot methodology

v0.1 records chain facts only. It does not produce a recovery eligibility list.

## Pinned state

Every inspection, extraction, and verification command requires a block hash. The block header supplies the block number, parent hash, and state root. The runtime version and genesis hash are recorded alongside them. A block number alone is not sufficient, and `latest` is never used for canonical output.

The candidate height mentioned in [canonical-snapshot.md](canonical-snapshot.md) is not a canonical selection.

## Authoritative state

The source of truth is the Moonbeam Substrate state at the pinned block. Runtime metadata is used through the decoded `assets.asset`, `assets.metadata`, and `assets.account` queries rather than hard-coded pallet indexes or SCALE layouts. `Assets.Account(assetId, account)` is enumerated with deterministic pagination. Keys must be strictly increasing, unique, and decodable; a repeated or malformed page fails the run.

All decoded accounts are normalized to lowercase H160 addresses. Zero-balance records are validated but omitted from the holder artifact. Non-zero holders are sorted by their raw 20-byte address, which is equivalent to lexicographic order of normalized lowercase hexadecimal.

## Exact quantities

Balances and supplies are unsigned integers. They are held as JavaScript `bigint` values internally and serialized as decimal strings. The display helper for 10 decimals inserts a decimal point using integer arithmetic; it never converts balances to `Number`.

The sum of canonical holder balances must equal the runtime asset total supply. The decoded account count must also equal the runtime account count. A mismatch is a hard failure.

## XC-20 verification

Moonbeam's XC-20 precompile is an independent EVM-facing view of the same asset. `evm-check` first queries the EVM block by the snapshot number and requires its returned hash to equal the pinned Substrate block hash. It then calls `symbol`, `decimals`, `totalSupply`, and `balanceOf` at that block number. Every holder balance and the total supply must match Substrate. This comparison is a verifier, not the authoritative extraction source.

Code classification is kept separate from balances. `eth_getCode == 0x` is `no_code`; it is not proof of EOA control. A failed code query is `unknown`.

## Canonical serialization

`holders.ndjson` is UTF-8, LF-delimited, fixed-key JSON with no extra whitespace, and a trailing newline when it contains records. Its SHA-256 is the holder-set digest. Human-oriented JSON and CSV files do not contribute to that digest.

The snapshot digest payload is exactly:

```text
xcdot-recovery-kit/snapshot/v1
<lowercase genesisHash>
<blockNumber>
<lowercase blockHash>
<lowercase stateRoot>
<assetId>
<decimals>
<totalSupplyPlanck>
<holderCount>
<lowercase holdersSha256>
```

There is a final LF after the last line. The SHA-256 of that UTF-8 payload is `snapshotDigest`. RPC URL, timestamps, host details, and command provenance are deliberately excluded and live in `provenance.json`.

### Test vector

Using genesis hash `0x` followed by 64 zeroes, block number `42`, block hash `0x` followed by 64 `11` characters, state root `0x` followed by 64 `22` characters, the configured asset ID, decimals `10`, total supply `30000000000`, holder count `2`, and a holder SHA-256 of 64 `33` characters, the digest is:

```text
50f8c5ff511c1ad7b309c5b7dab5eb2b89f38e3bda6c05f805f2832753656d03
```

## Completeness and trust boundary

Full enumeration plus supply reconciliation provides the completeness check for this artifact. An optional future storage read proof can prove one key's value, but cannot prove that no other holders exist. Contract-held balances remain exactly where the chain records them; ownership, beneficiary mapping, and fund execution belong to later policy layers.
