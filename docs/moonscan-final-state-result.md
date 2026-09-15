# Moonscan final-state reconciliation result

The Dwellir recovery was completed at the pinned Moonbeam state:

```ini
BLOCK_NUMBER=16796696
SUBSTRATE_BLOCK_HASH=0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
SUBSTRATE_STATE_ROOT=0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
CONTRACT=0xffffffff1fcacbd218edc0eba20fc2308c778080
TOTAL_SUPPLY_PLANCK=2334516727484230
```

All 7,667 addresses in the Subscan/Moonscan union were read successfully from
Dwellir `pallet_evm::AccountStorages` state. The 7,288-address Subscan cache was
reused; only the 379 Moonscan-only addresses required new live reads.

```ini
SUBSCAN_CANDIDATES=7288
MOONSCAN_ONLY_CANDIDATES=379
UNION_CANDIDATES=7667
FINAL_STATE_SUCCESS=7667
FINAL_POSITIVE_COUNT=1513
FINAL_ZERO_COUNT=6154
KNOWN_FINAL_SUM_PLANCK=1745914648371586
MOONSCAN_ONLY_FINAL_SUM_PLANCK=276516613218946
UNACCOUNTED_SUPPLY_PLANCK=588602079112644
STATUS=FINAL_STATE_SUPPLY_SHORTFALL
```

The known final sum is below total supply, so the union is not complete. The
shortfall is not equal to the historical Rank 565 balance
(`143274324851` planck); therefore Rank 565 is not individually identified as
the missing holder and broader missing-holder discovery is required.

The supply gate correctly stopped publication before proof generation:

```ini
PROOF_GENERATION=NOT_RUN
CANONICAL_SNAPSHOT=NOT_PUBLISHED
```

Local evidence is intentionally excluded from Git. The primary result files are:

- `diagnostics/moonscan-diff/final-state-summary.json`
- `diagnostics/moonscan-diff/source-summary.json`
- `diagnostics/dwellir-final-state-recovery-work/moonbeam-16796696/extensions/moonscan-a03149cc/results.ndjson`
- `snapshots/moonscan/0xffffffff1fcacbd218edc0eba20fc2308c778080.csv`

The candidate union digest is
`d7e71e02865231095b330eb9e2087898df757585a62048115365cb5c5229ec5c`; the
Moonscan-only address digest is
`a03149ccce13bd2243cc19856b4bccadb1269175211cbf918342dbad9cb499cb`.
