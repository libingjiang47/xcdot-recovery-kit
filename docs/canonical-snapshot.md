# Canonical snapshot status

Current observed candidate finalized height: **16,796,696**

Canonical status: **UNCONFIRMED**

The project does not hard-code this height or silently treat it as final. Before a community artifact is called canonical, run the same explicit block hash against at least two independent compatible Moonbeam RPC providers and compare:

1. finalized head and block hash;
2. state root, runtime version, and genesis hash;
3. xcDOT metadata and total supply;
4. holder count and `holders.ndjson` SHA-256;
5. snapshot digest;
6. EVM total supply and every holder balance.

Also confirm that no later canonical state exists, publish the evidence, and allow community review. The selected block should then be pinned in a dedicated commit. A successful first extraction is an engineering result, not by itself a governance decision.
