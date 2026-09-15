# Migration-era holder recovery

This report freezes the migration-era recovery result at Moonbeam block
`16,796,696`. It is an investigation result and must not be treated as a
canonical final snapshot.

## Pinned state

- Substrate block: `0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f`
- Substrate state root: `0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`
- EVM block hash: `0xc57e761b29c882d70c77ec21ee6aa74dda874aebc78bb9c5d3c4a6a577461c10`
- xcDOT total supply: `2334516727484230` planck

## Recovery result

The initial Subscan/Moonscan/SQD recovery baseline had a known final sum of
`1745914648371586` planck and a deficit of `588602079112644` planck. The
migration-era zero-address Transfer scan produced 11,786 unique candidate
recipients, of which 11,141 were extension-only addresses.

The union contained 18,429 candidate addresses. All 18,429 final-state reads
succeeded. The resulting set contained 11,785 positive addresses and 6,644
zero-balance candidates:

```text
known final sum       = 2334506800114108 planck
total supply          = 2334516727484230 planck
remaining deficit     = 9927370122 planck
remaining deficit     = 0.9927370122 xcDOT
```

Migration-era candidates explain almost the entire earlier shortfall, but the
supply equality is not reached. The remaining deficit is not assigned to Rank
565: `requiredForFinalCompleteness` remains `null`.

## Status boundary

```text
FINAL_STATE_SUPPLY_SHORTFALL
NOT VERIFIED
NOT CANONICAL
PROOF VERIFICATION NOT COMPLETE
```

The candidate logs are discovery evidence only. Final balances were read from
the pinned Moonbeam state, but this phase did not complete read-proof capture
and offline trie verification for the full candidate set. No canonical holder
snapshot or recovery policy artifact is authorized by this result.

The full local evidence bundle is indexed by
`evidence/migration-recovery-2026-09-14/manifest.json`.
