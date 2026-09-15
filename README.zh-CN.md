# xcDOT Recovery Kit

[English](README.md) · **简体中文** · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md)

用于恢复并验证 Moonbeam 终态 xcDOT 余额的开源工具与数据集。

**快照查询：** [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

当前快照包含 **11,785 个已知非零地址**。所有已发布余额均带有对应的 Substrate state proof，可以针对 Moonbeam 终态 state root 独立验证。

## 原理

Moonbeam 停止运行后，在没有完整备份节点的情况下，我们通过公开 RPC、区块链浏览器和索引数据恢复可能持有 xcDOT 的地址集合，并查询这些地址在终态中的余额。

但这些数据源本身并不可信。RPC 或区块链浏览器可能存在索引缺失、历史数据不完整或错误，因此本项目不会把它们返回的余额直接作为最终结果。

我们只将 Moonbeam 终态的 **state root** 作为链状态的信任锚。已发布的 xcDOT 余额都带有对应的 Substrate state proof，并可以离线验证。

## 终态区块

本项目锚定 Moonbeam：

```text
区块号     16,796,696
区块哈希   0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
State Root 0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
```

这是 **最后一个被 Polkadot 最终确认的 Moonbeam parachain 区块**。

恢复工作以 Polkadot 的最终性为准：[Moonbeam 区块 16,796,696](https://moonbeam.subscan.io/block/16796696)。

## 当前状态

| 项目           |                     数值 |
| -------------- | -----------------------: |
| 已知非零地址   |                   11,785 |
| 已知已验证余额 | 233,450.6800114108 xcDOT |
| xcDOT 总供应量 |  233,451.672748423 xcDOT |
| 尚未归属       |       0.9927370122 xcDOT |
| 已验证余额证明 |          11,785 / 11,785 |

当前已知余额覆盖总供应量约 **99.9995749%**。

剩余 `0.9927370122 xcDOT` 尚未归属，因此 11,785 表示当前已知的非零地址集合，而不是对所有可能持有者的完整性声明。

## 如何验证

克隆仓库：

```bash
git clone https://github.com/libingjiang47/xcdot-recovery-kit.git
cd xcdot-recovery-kit
```

安装并构建：

```bash
pnpm install --frozen-lockfile
pnpm build
```

验证发布文件哈希：

```bash
sha256sum -c SHA256SUMS
```

离线验证全部余额 proof：

```bash
NO_NETWORK=1 pnpm verify:release
```

完整快照应得到：

```text
PROOF_BATCHES=93/93
PROOF_ADDRESSES=11785/11785
TOTAL_SUPPLY_PROOF=PASS
BALANCE_PROOFS_VERIFIED=11785
OFFLINE_VERIFICATION=PASS
STATUS=PASS
```

## 快照查询

静态查询页面：[https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

可以查询地址余额、查看对应 proof，并下载独立 evidence。网站本身不会在运行时查询 RPC。

## 免责声明

本项目仅用于恢复和验证公开链上状态。

其中的地址、余额和证明不构成任何形式的资产所有权、领取资格、赔偿承诺、法律意见或财务建议。

本项目不代表 Moonbeam、Polkadot、Parity Technologies、Web3 Foundation、ArcheLabs 或任何其他相关组织。

任何实际资产恢复、分配或领取规则都应由独立的治理和执行机制决定。

## License

Apache-2.0，详见 [LICENSE](../LICENSE)。
