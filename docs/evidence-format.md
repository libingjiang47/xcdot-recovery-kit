# Evidence format

The frozen `data/` directory contains:

- `snapshot.json` — terminal state and economic constants;
- `holders.jsonl` and `holders.csv` — the deterministic known-positive holder list;
- `evidence-index.json` — address-to-proof and key-index mapping;
- `proofs/` — normalized Substrate read proofs;
- `raw/` — original `state_getStorage` and `state_getReadProof` responses.

Each balance proof is bound to the pinned block hash and state root. The proof
bundle records the Substrate storage key, raw storage value, decoded balance, and
the trie nodes returned for that key. `SHA256SUMS` covers the published `data/`
files.

The public frontend derives static indexes from these files. It does not add
evidence and does not contact a chain provider.
