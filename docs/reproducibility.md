# Reproducibility checklist

1. Use a clean checkout and Node.js 24 with the committed pnpm lockfile.
2. Run `pnpm install`, `pnpm build`, and `pnpm test`.
3. Select a candidate block by observation, then pin its full `0x` block hash.
4. Run `inspect`, `snapshot`, `verify`, and `evm-check` with that hash and provider.
5. Repeat against an independent provider.
6. Run `compare` and require identical block hash, state root, holder SHA-256, and snapshot digest.
7. Record the source commit, tag, Node/pnpm versions, lockfile hash, provider results, block hash, and snapshot digest in the release notes. Keep those provenance details out of the canonical manifest and digest.

Do not commit the first successful extraction as canonical before independent reproduction, supply verification, EVM verification, manual review of representative holders, and a clean-clone rerun.
