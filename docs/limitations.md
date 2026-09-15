# Current release limitations

The terminal-state evidence dataset contains 11,785 known non-zero holder
addresses. Their balances sum to `2334506800114108` planck
(`233450.6800114108 xcDOT`). The canonical total supply is
`2334516727484230` planck (`233451.672748423 xcDOT`), leaving
`9927370122` planck (`0.9927370122 xcDOT`) unattributed.

The absence of an address from this snapshot does not prove a zero balance.
Subscan, Moonscan, SQD, and other indexers are candidate discovery evidence;
the terminal balance values and read proofs are derived from Moonbeam's pinned
Substrate state.
