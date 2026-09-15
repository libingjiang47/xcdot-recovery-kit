import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { writeReleaseSums } from '../release/build.js';
import { CanonicalSerializationError } from '../utils/errors.js';
import { Command } from 'commander';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runVerifier(
  dataDirectory: string,
  configuredBinary: string | undefined,
  root: string,
  partial: boolean,
): Promise<string> {
  const binaryCandidates = [
    configuredBinary,
    join(root, 'target/release/evidence-verifier'),
    join(root, 'target/debug/evidence-verifier'),
  ].filter((value): value is string => value !== undefined);
  const binary = (
    await Promise.all(
      binaryCandidates.map(async (value) => ((await exists(value)) ? value : undefined)),
    )
  ).find(Boolean);
  const env: NodeJS.ProcessEnv = { ...process.env, NO_NETWORK: '1' };
  delete env.DWELLIR_KEY;
  delete env.MOONBEAM_RPC;
  delete env.SUBSCAN_API_KEY;
  const verifierArgs = [dataDirectory, '--release', ...(partial ? ['--partial-release'] : [])];
  if (binary) {
    const result = await execFileAsync(binary, verifierArgs, {
      cwd: root,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  }
  const result = await execFileAsync(
    'cargo',
    [
      'run',
      '--quiet',
      '--manifest-path',
      join(root, 'crates/evidence-verifier/Cargo.toml'),
      '--',
      dataDirectory,
      '--release',
      ...(partial ? ['--partial-release'] : []),
    ],
    { cwd: root, env, maxBuffer: 32 * 1024 * 1024 },
  );
  return result.stdout;
}

export function verifyReleaseCommand(): Command {
  const command = new Command('verify-release').description(
    'Verify the frozen release dataset and its Substrate proofs without network access',
  );
  command.option('--data <directory>', 'Release data directory', 'data');
  command.option('--verifier-binary <path>', 'Prebuilt evidence-verifier binary');
  command.option(
    '--partial',
    'Verify currently captured proof batches without requiring full coverage',
  );
  command.action(async (options: { data: string; verifierBinary?: string; partial?: boolean }) => {
    const root = resolve(process.cwd());
    const dataDirectory = resolve(options.data);
    const stdout = await runVerifier(
      dataDirectory,
      options.verifierBinary,
      root,
      options.partial ?? false,
    );
    process.stdout.write(stdout);
    if (options.partial && stdout.includes('STATUS=PARTIAL_PASS')) {
      return;
    }
    if (!stdout.includes('STATUS=PASS')) {
      throw new CanonicalSerializationError('Release verifier did not report STATUS=PASS.');
    }
    const snapshotPath = join(dataDirectory, 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      status?: string;
      recovery?: { unattributedPlanck?: string };
      proofStatus?: Record<string, unknown>;
      limitations?: Record<string, unknown>;
    };
    snapshot.proofStatus = {
      ...(snapshot.proofStatus ?? {}),
      totalSupplyVerified: true,
      knownBalanceProofsVerified: true,
    };
    snapshot.status = 'READY';
    snapshot.limitations = {
      ...(snapshot.limitations ?? {}),
      holderDiscoveryComplete: snapshot.recovery?.unattributedPlanck === '0',
    };
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await writeReleaseSums(root, dataDirectory);
    console.log(`STATUS=${snapshot.status}`);
  });
  return command;
}
