# Subscan discovery import

The Subscan export is an enumeration aid, not an authoritative final-state balance source. The importer preserves every direct ordinary `.csv` byte artifact and binds the derived candidate set to a SHA-256 manifest. Final balances must be checked independently against the xcDOT contract at a pinned EVM block.

## Observed schema

The 73 supplied files were inspected before implementation. Every file has exactly this UTF-8 CSV header and three columns:

```text
Rank,Account,Balance
```

`Rank` is an unsigned decimal rank, `Account` is the H160 address, and `Balance` is the xcDOT decimal amount. No percentage, token-name, or additional field was observed. The explicit adapter rejects other headers or column counts. UTF-8 BOM and CRLF/LF record endings are accepted; quoted fields, escaped quotes, quoted commas, and quoted newlines are parsed by the RFC 4180 state-machine parser in `src/subscan/csv.ts`.

The observed export uses a second, explicit balance representation for values with thousands separators: `1,234` or `1,234.5678901234`. The adapter accepts only a complete first-group-plus-three-digit-groups pattern, removes those commas after validation, and then applies the same 10-decimal limit. It does not strip arbitrary non-numeric characters.

Only leading/trailing CSV field whitespace is trimmed for address and balance validation. Whitespace inside an address is invalid. The original field text remains in `derived/provenance.ndjson`.

## Exact normalization

Addresses must match `^0x[0-9a-fA-F]{40}$` after the documented trim and are lowercased. Balances must match an unsigned decimal with at most 10 fractional digits. The integer representation is calculated as:

```text
whole * 10^10 + fractional_digits_padded_to_10
```

All token arithmetic uses `BigInt`; no floating-point conversion is used. Leading zeroes are removed from the integer part. Negative values, empty values, scientific notation, locale separators, and excess precision fail with a stable error code.

Every valid raw record retains source file, source row, raw address, and raw balance. Same-address/same-balance records are recorded in `duplicates.ndjson` and collapsed. Same-address/conflicting-balance records fail. Exact file-byte duplicates and semantic ordered-page duplicates fail.

## Artifacts

`RAW_SHA256SUMS` and `raw-manifest.json` freeze the direct CSV inputs. The raw dataset digest is the SHA-256 of the exact `RAW_SHA256SUMS` bytes. The derived candidate set contains positive balances only, sorted by lower-case address, with fixed JSON key ordering and LF endings. `summary.json` is always `DISCOVERY_ONLY`; it must not be interpreted as a canonical recovery claim.

Verification-only mode runs discovery, parsing, audit, normalization, and digest calculation without modifying raw-manifest or derived output:

```bash
node dist/cli/index.js import-subscan \
  --input snapshots/subscan \
  --expected-files 73 \
  --check-only
```
