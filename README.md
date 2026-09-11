# xcDOT Recovery Kit

Independent open-source tooling for reconstructing and verifying the final xcDOT holder state on Moonbeam.

The project exists to provide a deterministic, reproducible factual basis for community discussion around stranded xcDOT after Moonbeam's shutdown.

It does not determine recovery eligibility, control funds, or represent Moonbeam, Polkadot, Parity Technologies, Web3 Foundation, or ArcheLabs.

## What it does

v0.1 binds extraction to an explicit Moonbeam block hash, validates the xcDOT asset identity, enumerates `Assets.Account` using runtime metadata, reconciles balances against total supply, and writes a deterministic `holders.ndjson` plus hashes and manifest data. The optional EVM verifier checks the XC-20 `balanceOf` and `totalSupply` at the same block context.

The authoritative output is a statement of chain state. Contract-held balances remain in the holder set; no beneficiary or recovery entitlement is inferred.

## What it does not do

This release does not move funds, generate claims, determine beneficiaries, reconstruct DeFi positions, connect wallets, deploy contracts, or use explorer holder pages as inputs.

## Install and test

Requirements: Node.js 24 and pnpm.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
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

The observed finalized height `16,796,696` is retained as an unconfirmed candidate in the documentation. This repository does not declare that block canonical. Canonical publication requires multi-provider agreement, supply reconciliation, EVM verification, review, and a deliberate commit.

## License

Apache-2.0. See [LICENSE](LICENSE).
