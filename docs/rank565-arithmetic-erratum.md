# Rank 565 arithmetic erratum

This erratum corrects one diagnostic-only number. It does not rewrite the raw Subscan CSV files or
any historical report artifact.

The valid raw-row balance sum is `3054659641926760` planck. Removing the one exact duplicate
occurrence of `9927370121` planck gives the unique valid-address sum
`3054649714556639` planck. Adding the historical Rank 565 row (`143274324851` planck) gives the
correct Rank-565-adjusted diagnostic total:

```text
3054792988881490
```

The earlier value `3054783061511369` was wrong because the duplicate balance had already been
removed while calculating the unique valid-address subtotal and was deducted a second time. The
earlier reports remain preserved as historical evidence; this file is the correction.

These values are Subscan diagnostics only. v0.26 treats Subscan balances as historical observations
and obtains final balances from the pinned Moonbeam EVM or Substrate-backed state.
