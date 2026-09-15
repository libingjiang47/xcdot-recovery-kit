import { Command } from 'commander';
import { resolve } from 'node:path';
import { writeReleaseSums } from '../release/checksums.js';

export function refreshReleaseSumsCommand(): Command {
  const command = new Command('refresh-release-sums').description(
    'Refresh the maintainer checksum manifest for the frozen release data',
  );
  command.option('--data <directory>', 'Release data directory', 'data');
  command.action(async (options: { data: string }) => {
    await writeReleaseSums(process.cwd(), resolve(options.data));
    console.log('RELEASE_SUMS=REFRESHED');
  });
  return command;
}
