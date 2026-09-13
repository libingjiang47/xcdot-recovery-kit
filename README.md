# xcDOT Recovery Kit

Independent open-source tooling for reconstructing and verifying the final xcDOT holder state on Moonbeam.

The project exists to provide a deterministic, reproducible factual basis for community discussion around stranded xcDOT after Moonbeam's shutdown.

It does not determine recovery eligibility, control funds, or represent Moonbeam, Polkadot, Parity Technologies, Web3 Foundation, or ArcheLabs.

## What it does

v0.26 retains the v0.2/v0.25 evidence paths and adds final-state reconstruction from the pinned EVM contract state. Subscan contributes only the normalized candidate H160 set; `reconstruct-final-state` queries `balanceOf` and `totalSupply` at one explicit EVM block, persists an append-only checkpoint, and reports exact supply completeness without using Subscan balances as an invariant. The metadata-derived `pallet_evm::AccountStorages` backend refuses to guess Solidity slots and can acquire read proofs once a provenance-bearing storage-layout artifact is supplied. The Rank 565 diagnostic remains a separate, non-canonical investigation path.

The authoritative output is a statement of chain state. Contract-held balances remain in the holder set; no beneficiary or recovery entitlement is inferred.

## What it does not do

This release does not move funds, generate claims, determine beneficiaries, reconstruct DeFi positions, connect wallets, deploy contracts, or treat Subscan balances as authoritative final state.

## Install and test

Requirements: Node.js 24 and pnpm.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
cargo test --workspace
```

All normal tests use local fixtures and do not require an RPC.

## Reproduce a snapshot

An explicit block hash is mandatory. The tool never silently uses `latest`.

```bash
xcdot-recovery probe --rpc <moonbeam-substrate-rpc>
xcdot-recovery inspect --rpc <moonbeam-substrate-rpc> --block-hash <hash>
xcdot-recovery snapshot --rpc <moonbeam-substrate-rpc> --block-hash <hash> --out snapshots
xcdot-recovery verify --rpc <moonbeam-substrate-rpc> --snapshot snapshots/<number>-<short-hash>
xcdot-recovery evm-check --rpc <moonbeam-evm-rpc> --snapshot snapshots/<number>-<short-hash>
xcdot-recovery capture-evidence --rpc <moonbeam-substrate-rpc> --block-hash <hash> --out evidence
xcdot-recovery verify-evidence --bundle evidence/<number>-<short-hash>
xcdot-recovery import-subscan --input snapshots/subscan --expected-files 73
xcdot-recovery verify-subscan-final-state --dataset snapshots/subscan/derived --evm-rpc <moonbeam-evm-rpc> --block-number <number> --substrate-block-hash <hash>
xcdot-recovery diagnose-rank565 --dataset snapshots/subscan --evm-rpc <moonbeam-evm-rpc> --block-number 16796696 --from-block <justified-start>
xcdot-recovery reconstruct-final-state --dataset snapshots/subscan --evm-rpc <moonbeam-evm-rpc> --block-number 16796696 --expected-total-supply 2334516727484230 --resume
xcdot-recovery probe-subscan-final-state --dataset snapshots/final-state/moonbeam-16796696 --out diagnostics/subscan-final-state-probe
xcdot-recovery probe-subscan-final-state --access direct-subscan --dataset snapshots/final-state/moonbeam-16796696 --out diagnostics/subscan-final-state-probe-direct
xcdot-recovery inspect-evm-storage-layout --substrate-rpc <moonbeam-substrate-rpc> --block-hash <hash> --layout <verified-layout.json>
xcdot-recovery extract-final-state-storage --substrate-rpc <moonbeam-substrate-rpc> --block-hash <hash> --dataset snapshots/subscan --layout <verified-layout.json>
xcdot-recovery probe-substrate-archive --rpc <moonbeam-substrate-rpc> --block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
xcdot-recovery probe-substrate-archive-matrix --block-hash 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f --provider onfinality=<rpc> --provider foundation=<rpc>
xcdot-recovery probe-nownodes-final-state
xcdot-recovery probe-dwellir-final-state
xcdot-recovery probe-dwellir-final-state-direct
xcdot-recovery recover-dwellir-final-state --dataset snapshots/subscan --moonscan-csv snapshots/moonscan/0xffffffff1fcacbd218edc0eba20fc2308c778080.csv --expected-total-supply 2334516727484230 --resume
xcdot-recovery recover-dwellir-final-state --dataset snapshots/subscan --candidate-extension snapshots/routescan/xcdot-holders.ndjson --expected-total-supply 2334516727484230 --resume
xcdot-recovery fetch-sqd-xcdot-candidates --from-block 0 --to-block 16796696 --resume
xcdot-recovery recover-sqd-backward --dataset snapshots/subscan --moonscan-csv snapshots/moonscan/0xffffffff1fcacbd218edc0eba20fc2308c778080.csv --window-blocks 10000 --max-unproductive-windows 20 --resume
```

`--rpc` may be omitted only when `MOONBEAM_RPC` is set. No third-party provider is selected automatically.

Run the same explicit block against at least two independent providers and compare the resulting directories:

```bash
xcdot-recovery compare snapshots/provider-a snapshots/provider-b
```

The canonical identity excludes RPC URL, timestamps, host information, and other provenance. Those are kept in `provenance.json`.

## Trust boundary

The snapshot reports which H160 accounts held xcDOT at a particular Moonbeam state root. It does not decide who should receive native DOT, how a contract-held balance should be distributed, or which governance mechanism should authorize recovery. Those are separate future policy and execution layers.

`eth_getCode == 0x` is recorded as `no_code`, not as proof that an address is an EOA. Ownership would require a later proof of control.

## Current status

The observed finalized height `16,796,696` remains an unconfirmed candidate. On the current Moonbeam runtime, the old `Assets` storage backend is absent and xcDOT is EVM-backed, so `capture-evidence` fails closed rather than publishing an incomplete holder set. The supplied Subscan dataset is currently frozen but does not pass import: one source row has an empty `Account` at Rank 565. This repository does not declare that block canonical.

See [Subscan import](docs/subscan-import.md), [real import audit](docs/subscan-real-import.md), [final-state verification](docs/subscan-final-state-verification.md), [v0.26 final-state reconstruction](docs/final-state-reconstruction.md), [Moonscan candidate reconciliation](docs/moonscan-final-state-reconciliation.md), [generic candidate extensions](docs/candidate-extension.md), [SQD Transfer candidate discovery](docs/sqd-transfer-candidate-discovery.md), [SQD backward recovery](docs/sqd-backward-recovery.md), [Moonscan final-state result](docs/moonscan-final-state-result.md), [Subscan/PubFi final-state probe](docs/subscan-final-state-probe.md), [historical Substrate archive probe](docs/substrate-archive-probe.md), [NOWNodes final-state proof probe](docs/nownodes-final-state-probe.md), [Dwellir final-state proof probe](docs/dwellir-final-state-probe.md), [Dwellir direct final-state probe](docs/dwellir-final-state-direct-probe.md), [Rank 565 diagnostic](docs/rank565-diagnostic.md), and the [Rank 565 arithmetic erratum](docs/rank565-arithmetic-erratum.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
