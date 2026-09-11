# Evidence bundle format

`capture-evidence` creates a directory named by the pinned block number and hash. The final
directory is published only after all raw values and proof batches have been captured.

Canonical state is kept separate from provenance:

- `header/header.scale.hex` is the exact SCALE block header returned at the pinned hash.
- `state/storage.ndjson` keeps the exact lowercase raw storage keys and values used by the
  snapshot. Its account records also contain the decoded integer balance used for the holder
  artifact.
- `proofs/batch-*.json` contains the exact raw trie nodes returned by `state_getReadProof`.
- `runtime/metadata.scale.hex` preserves the metadata bytes needed to interpret the state.
- `evidence-core.json`, `canonical-files.sha256`, and `evidence-manifest.json` bind the
  semantic state and all canonical file hashes.

`provenance.json` may contain RPC URL, capture time, host information, and tool commit. It is
not part of `evidenceDigest`. The digest is SHA-256 of `canonical-files.sha256`, which itself
lists the canonical files in UTF-8 path order and excludes the manifest, provenance, and hash
list files.

The first supported capture backend is metadata-discovered legacy `Assets.Asset`,
`Assets.Metadata`, and `Assets.Account`. A runtime that has migrated xcDOT to an EVM-backed
foreign-asset contract must fail closed until a complete H160 holder enumeration and proof
model is available.
