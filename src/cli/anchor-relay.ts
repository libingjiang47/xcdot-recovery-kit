import { Command } from 'commander';
import { EvidenceCaptureError } from '../utils/errors.js';

export function anchorRelayCommand(): Command {
  const command = new Command('anchor-relay').description(
    'Capture an independent Polkadot relay-chain anchor for an evidence bundle',
  );
  command.requiredOption('--bundle <directory>', 'Evidence bundle directory');
  command.requiredOption('--rpc <url>', 'Polkadot relay-chain RPC endpoint');
  command.option('--para-id <id>', 'Parachain ID', '2004');
  command.action(() => {
    throw new EvidenceCaptureError(
      'Relay anchoring is intentionally separate from the first Moonbeam evidence capture and is not enabled yet.',
    );
  });
  return command;
}
