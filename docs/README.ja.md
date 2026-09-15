# xcDOT Recovery Kit

[English](../README.md) · [简体中文](README.zh-CN.md) · **日本語** · [Deutsch](README.de.md) · [Français](README.fr.md)

Moonbeam の最終状態における xcDOT 残高を復元・検証するためのオープンソースツールとデータセットです。

**スナップショット検索：** [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

現在のスナップショットには **既知の非ゼロアドレス 11,785 件** が含まれています。公開されているすべての残高には対応する Substrate state proof があり、Moonbeam の最終状態 root に対して独立に検証できます。

## 原則

Moonbeam の稼働停止後、完全なバックアップノードがない状況で、公開 RPC、ブロックエクスプローラー、インデックスデータから xcDOT を保有していた可能性のあるアドレス集合を復元し、最終状態での残高を取得しました。

ただし、これらのデータソースを最終的な権威とはみなしません。RPC やエクスプローラーにはインデックス欠落、過去データの不足、誤った結果があり得るため、返された残高をそのまま最終結果として採用しません。

チェーン状態の信頼アンカーは Moonbeam 最終ブロックの **state root** だけです。公開残高には対応する Substrate state proof が含まれ、オフラインで検証できます。

## 最終ブロック

本プロジェクトは次の Moonbeam 状態を基準にしています。

```text
ブロック番号 16,796,696
ブロックハッシュ 0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
State Root 0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
```

これは **Polkadot によってファイナライズされた最後の Moonbeam parachain ブロック**です。

復元作業では Polkadot のファイナリティを基準にしています：[Moonbeam ブロック 16,796,696](https://moonbeam.subscan.io/block/16796696)。

## 現在の状態

| 項目                 |                       値 |
| -------------------- | -----------------------: |
| 既知の非ゼロアドレス |                   11,785 |
| 既知の検証済み残高   | 233,450.6800114108 xcDOT |
| xcDOT 総供給量       |  233,451.672748423 xcDOT |
| 未帰属               |       0.9927370122 xcDOT |
| 検証済み残高 proof   |          11,785 / 11,785 |

既知の残高は総供給量の約 **99.9995749%** を占めます。

残りの `0.9927370122 xcDOT` は未帰属です。したがって 11,785 件は現在判明している非ゼロアドレス集合であり、存在し得るすべての保有者が含まれるという主張ではありません。

## 検証方法

リポジトリをクローンします。

```bash
git clone https://github.com/libingjiang47/xcdot-recovery-kit.git
cd xcdot-recovery-kit
```

インストールしてビルドします。

```bash
pnpm install --frozen-lockfile
pnpm build
```

公開ファイルのハッシュを検証します。

```bash
sha256sum -c SHA256SUMS
```

すべての残高 proof をオフラインで検証します。

```bash
NO_NETWORK=1 pnpm verify:release
```

完全なスナップショットでは次の結果が得られます。

```text
PROOF_BATCHES=93/93
PROOF_ADDRESSES=11785/11785
TOTAL_SUPPLY_PROOF=PASS
BALANCE_PROOFS_VERIFIED=11785
OFFLINE_VERIFICATION=PASS
STATUS=PASS
```

## スナップショット検索

静的検索ページ：[https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

アドレス残高の検索、対応する proof の表示、独立した evidence のダウンロードができます。サイトは実行時に RPC へ接続しません。

## 免責事項

本プロジェクトは公開されたオンチェーン状態の復元と検証のみを目的としています。

アドレス、残高、proof は、資産所有権、請求資格、補償の約束、法的助言、金融上の助言を意味しません。

本プロジェクトは Moonbeam、Polkadot、Parity Technologies、Web3 Foundation、ArcheLabs、その他の関連組織を代表するものではありません。

実際の資産の復元、分配、請求に関する規則は、独立したガバナンスおよび実行メカニズムによって決定されるべきです。

## License

Apache-2.0。[LICENSE](../LICENSE) を参照してください。
