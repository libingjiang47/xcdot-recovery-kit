# Verification

The release is anchored to Moonbeam block `16,796,696`:

- block hash: `0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f`
- state root: `0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb`
- state version: `1`

Build the verifier and run the release check without network access:

```bash
pnpm install --frozen-lockfile
pnpm build
NO_NETWORK=1 pnpm verify:release
```

The verifier checks the total-supply proof, all 93 balance proof batches, raw RPC
responses, storage keys and values, holder ordering, balances, and the frozen
release checksums. A successful run reports `STATUS=PASS`.

The state root is the trust anchor. RPC providers, explorers, and indexers are
discovery or capture sources, not final authorities.
