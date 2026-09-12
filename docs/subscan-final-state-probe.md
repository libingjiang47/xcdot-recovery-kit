# Subscan/PubFi final-state minimal probe

`probe-subscan-final-state` is a diagnostic-only capability probe for Moonbeam block
`16,796,696`. It tests the current PubFi Runtime OpenAPI/Registry route, the pinned block
header/state root, xcDOT historical `totalSupply`, and exactly five deterministic candidate
addresses.

It does not query all 7,288 candidates, replay Transfer history, change the source CSV or
candidate-address artifact, or create a canonical snapshot. The candidate file is used only for
the first five addresses:

```text
snapshots/final-state/moonbeam-16796696/candidate-addresses.ndjson
```

## Run

Load the local PubFi key into the environment without putting it in command arguments or files:

```bash
set -a
source /path/to/xcdot-recovery-kit.key
set +a
test -n "$PUBFI_KEY"
```

Then run the probe from WSL:

```bash
node dist/cli/index.js probe-subscan-final-state \
  --dataset snapshots/final-state/moonbeam-16796696 \
  --out diagnostics/subscan-final-state-probe
```

The client discovers the current Subscan capabilities from PubFi's public Registry and Runtime
OpenAPI, prefers the published Moonbeam template route, and uses the published free variant when
the contract exposes one. Gateway calls use `Authorization: Bearer $PUBFI_KEY`; Registry and
OpenAPI discovery calls are public. No key value is written to diagnostics.

## Pinned checks

The probe requires the returned header to identify block `16,796,696` and state root
`0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`. It then requires the
historical xcDOT supply to be the exact planck integer `2334516727484230`. Balance results are
required to be non-negative decimal integers; zero is valid, and old CSV balances are not used as
a gate.

## Statuses

`SUBSCAN_FINAL_STATE_CAPABLE` means all three checks passed and a later task may query the full
candidate set. `PUBFI_ROUTE_UNAVAILABLE` means route discovery was unavailable or not ready;
`SUBSCAN_BLOCK_MISMATCH` and `SUBSCAN_HISTORICAL_STATE_MISMATCH` are fail-closed state checks;
`SUBSCAN_BALANCE_HISTORY_UNAVAILABLE` means the header and supply passed but at least one of the
five balance responses was unavailable or invalid.

The five artifacts are written only below `diagnostics/subscan-final-state-probe/`:

```text
README.md
header.json
total-supply.json
sample-balances.ndjson
report.txt
```
