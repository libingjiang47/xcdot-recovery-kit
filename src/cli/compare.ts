import { Command } from 'commander';
import { readHolders, readManifest } from '../snapshot/io.js';
import type { HolderRecord } from '../types.js';

interface HolderChange {
  address: string;
  balanceA?: string;
  balanceB?: string;
}

function compareHolders(
  a: readonly HolderRecord[],
  b: readonly HolderRecord[],
): {
  onlyInA: HolderRecord[];
  onlyInB: HolderRecord[];
  balanceChanged: HolderChange[];
} {
  const aMap = new Map(a.map((holder) => [holder.address, holder.balancePlanck]));
  const bMap = new Map(b.map((holder) => [holder.address, holder.balancePlanck]));
  const onlyInA: HolderRecord[] = [];
  const onlyInB: HolderRecord[] = [];
  const balanceChanged: HolderChange[] = [];
  for (const [address, balancePlanck] of aMap) {
    const other = bMap.get(address);
    if (other === undefined) onlyInA.push({ address, balancePlanck });
    else if (other !== balancePlanck)
      balanceChanged.push({ address, balanceA: balancePlanck, balanceB: other });
  }
  for (const [address, balancePlanck] of bMap) {
    if (!aMap.has(address)) onlyInB.push({ address, balancePlanck });
  }
  return { onlyInA, onlyInB, balanceChanged };
}

export function compareCommand(): Command {
  const command = new Command('compare').description('Compare two snapshot artifacts');
  command.argument('<snapshotA>', 'First snapshot directory');
  command.argument('<snapshotB>', 'Second snapshot directory');
  command.action(async (snapshotA: string, snapshotB: string) => {
    const [manifestA, manifestB, holdersA, holdersB] = await Promise.all([
      readManifest(snapshotA),
      readManifest(snapshotB),
      readHolders(snapshotA),
      readHolders(snapshotB),
    ]);
    const holders = compareHolders(holdersA.holders, holdersB.holders);
    const headerEqual =
      manifestA.chain.genesisHash === manifestB.chain.genesisHash &&
      manifestA.snapshot.blockHash === manifestB.snapshot.blockHash &&
      manifestA.snapshot.stateRoot === manifestB.snapshot.stateRoot;
    const assetEqual = JSON.stringify(manifestA.asset) === JSON.stringify(manifestB.asset);
    const match =
      headerEqual &&
      assetEqual &&
      manifestA.holders.sha256 === manifestB.holders.sha256 &&
      manifestA.snapshotDigest === manifestB.snapshotDigest &&
      holders.onlyInA.length === 0 &&
      holders.onlyInB.length === 0 &&
      holders.balanceChanged.length === 0;
    console.log(`CANONICAL_DATA_MATCH=${match ? 'PASS' : 'FAIL'}`);
    console.log(
      JSON.stringify(
        {
          headerEqual,
          assetEqual,
          snapshotA: {
            holdersSha256: manifestA.holders.sha256,
            snapshotDigest: manifestA.snapshotDigest,
          },
          snapshotB: {
            holdersSha256: manifestB.holders.sha256,
            snapshotDigest: manifestB.snapshotDigest,
          },
          holders,
        },
        null,
        2,
      ),
    );
    if (!match) process.exitCode = 1;
  });
  return command;
}
