import { Command } from 'commander';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EvidenceVerificationError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function verifierCommand(bundle: string): Promise<{ file: string; args: string[] }> {
  const root = resolve(process.cwd());
  const candidates = [
    join(root, 'target/release/evidence-verifier'),
    join(root, 'target/debug/evidence-verifier'),
    join(root, 'crates/evidence-verifier/target/release/evidence-verifier'),
    join(root, 'crates/evidence-verifier/target/debug/evidence-verifier'),
  ];
  for (const file of candidates) if (await exists(file)) return { file, args: [bundle] };
  const manifest = join(root, 'crates/evidence-verifier/Cargo.toml');
  if (!(await exists(manifest))) {
    throw new EvidenceVerificationError(
      'The offline Rust verifier is not available in this checkout.',
    );
  }
  return {
    file: 'cargo',
    args: ['run', '--offline', '--quiet', '--manifest-path', manifest, '--', bundle],
  };
}

export function verifyEvidenceCommand(): Command {
  const command = new Command('verify-evidence').description(
    'Verify a frozen evidence bundle without network access',
  );
  command.requiredOption('--bundle <directory>', 'Evidence bundle directory');
  command.action(async (options: { bundle: string }) => {
    const bundle = resolve(options.bundle);
    const commandLine = await verifierCommand(bundle);
    try {
      const result = await execFileAsync(commandLine.file, commandLine.args, {
        cwd: process.cwd(),
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      if (failure.stdout) process.stdout.write(failure.stdout);
      if (failure.stderr) process.stderr.write(failure.stderr);
      throw new EvidenceVerificationError(
        `Offline evidence verification failed: ${failure.message ?? String(error)}`,
      );
    }
  });
  return command;
}
