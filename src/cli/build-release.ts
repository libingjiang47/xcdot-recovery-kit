import { Command } from 'commander';
import { buildFrozenRelease } from '../release/build.js';

export function buildReleaseCommand(): Command {
  const command = new Command('build-release').description(
    'Freeze the known terminal xcDOT balances into a deterministic, non-canonical release dataset',
  );
  command.option('--source <file>', 'Frozen final-balances NDJSON source');
  command.option('--out <directory>', 'Release data directory', 'data');
  command.action(async (options: { source?: string; out: string }) => {
    const result = await buildFrozenRelease({
      ...(options.source === undefined ? {} : { source: options.source }),
      out: options.out,
    });
    console.log(`RELEASE_DATA=${result.dataDirectory}`);
    console.log(`KNOWN_POSITIVE_HOLDERS=${result.holderCount}`);
    console.log(`KNOWN_BALANCE_SUM_PLANCK=${result.knownSumPlanck}`);
    console.log(`UNATTRIBUTED_PLANCK=${result.unattributedPlanck}`);
    console.log(`STATUS=UNATTRIBUTED_SHORTFALL`);
  });
  return command;
}
