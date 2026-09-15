# Generic candidate extensions

`recover-dwellir-final-state` accepts an address-only NDJSON extension from an
independent discovery source:

```json
{ "address": "0x..." }
```

The parser accepts one JSON object per line, normalizes H160 addresses to
lowercase, deduplicates them, sorts them, and binds the run to the source-file
SHA-256. Extra fields are ignored and must not be treated as final balances.

Run it with:

```sh
node dist/cli/index.js recover-dwellir-final-state \
  --dataset snapshots/subscan \
  --candidate-extension snapshots/routescan/xcdot-holders.ndjson \
  --expected-total-supply 2334516727484230 \
  --connect-timeout-ms 120000 \
  --timeout-ms 300000 \
  --storage-concurrency 2 \
  --resume
```

The recovery unions the extension addresses with the frozen Subscan set,
reuses every compatible cached `AccountStorages` value, and queries only
uncached addresses. Extension balances are diagnostic only; authoritative
balances still come from Dwellir pinned-state storage and the existing supply
gate/proof path.
