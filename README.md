# xcDOT Recovery Kit

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md)

Open-source tools and datasets for recovering and verifying final-state xcDOT balances on Moonbeam.

**Snapshot explorer:** [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

The current snapshot contains **11,785 known non-zero addresses**. Every published balance carries a corresponding Substrate state proof that can be verified independently against Moonbeam's terminal state root.

## Principle

After Moonbeam stopped operating, and without a complete backup node, we reconstructed the set of addresses that may have held xcDOT from public RPC endpoints, block explorers, and indexed data, then queried their balances at the terminal state.

Those sources are not trusted as final authorities. RPC providers and explorers can have missing indexes, incomplete historical data, or incorrect results, so their returned balances are not accepted directly as the final result.

The only chain-state trust anchor is the **state root** of the Moonbeam terminal block. Published xcDOT balances include their corresponding Substrate state proofs and can be verified offline.

## Terminal block

This project is anchored to the following Moonbeam state:

```text
Block Number 16,796,696
Block Hash   0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
State Root   0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
```

This is the **last Moonbeam parachain block finalized by Polkadot**.

The recovery work uses Polkadot finality as its reference: [Moonbeam block 16,796,696](https://moonbeam.subscan.io/block/16796696).

## Current status

| Item                     |                    Value |
| ------------------------ | -----------------------: |
| Known non-zero addresses |                   11,785 |
| Known verified balance   | 233,450.6800114108 xcDOT |
| xcDOT total supply       |  233,451.672748423 xcDOT |
| Unattributed             |       0.9927370122 xcDOT |
| Verified balance proofs  |          11,785 / 11,785 |

The known balances cover approximately **99.9995749%** of total supply.

The remaining `0.9927370122 xcDOT` is unattributed. Therefore, 11,785 is the current known non-zero address set, not a completeness claim about every possible holder.

## Verify the release

Clone the repository:

```bash
git clone https://github.com/libingjiang47/xcdot-recovery-kit.git
cd xcdot-recovery-kit
```

Install and build:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Verify release hashes:

```bash
sha256sum -c SHA256SUMS
```

Verify every balance proof offline:

```bash
NO_NETWORK=1 pnpm verify:release
```

The complete release should report:

```text
PROOF_BATCHES=93/93
PROOF_ADDRESSES=11785/11785
TOTAL_SUPPLY_PROOF=PASS
BALANCE_PROOFS_VERIFIED=11785
OFFLINE_VERIFICATION=PASS
STATUS=PASS
```

## Snapshot explorer

Open the static query page:

[https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

It can look up an address balance, show its associated proof, and download independent evidence. The website never queries an RPC at runtime.

Technical details: [verification](docs/verification.md), [evidence format](docs/evidence-format.md),
[threat model](docs/threat-model.md), [limitations](docs/limitations.md), and
[frontend](docs/frontend.md).

## Disclaimer

This project is solely for recovering and verifying publicly observable on-chain state.

Addresses, balances, and proofs do not constitute any form of asset ownership determination, claim eligibility, compensation promise, legal advice, or financial advice.

This project does not represent Moonbeam, Polkadot, Parity Technologies, Web3 Foundation, ArcheLabs, or any other related organization.

Any rules for actual asset recovery, distribution, or claims must be determined by independent governance and execution mechanisms.

## License

Apache-2.0. See [LICENSE](LICENSE).
