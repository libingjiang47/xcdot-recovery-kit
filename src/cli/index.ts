#!/usr/bin/env node
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { asXcDotError } from '../utils/errors.js';
import { probeCommand } from './probe.js';
import { inspectCommand } from './inspect.js';
import { snapshotCommand } from './snapshot.js';
import { verifyCommand } from './verify.js';
import { compareCommand } from './compare.js';
import { evmCheckCommand } from './evm-check.js';
import { captureEvidenceCommand } from './capture-evidence.js';
import { verifyEvidenceCommand } from './verify-evidence.js';
import { anchorRelayCommand } from './anchor-relay.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('xcdot-recovery')
    .description('Deterministic xcDOT state extraction and verification toolkit')
    .version('0.2.0')
    .showSuggestionAfterError();
  program.addCommand(probeCommand());
  program.addCommand(inspectCommand());
  program.addCommand(snapshotCommand());
  program.addCommand(verifyCommand());
  program.addCommand(compareCommand());
  program.addCommand(evmCheckCommand());
  program.addCommand(captureEvidenceCommand());
  program.addCommand(verifyEvidenceCommand());
  program.addCommand(anchorRelayCommand());
  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      const normalized = asXcDotError(error);
      console.error(`${normalized.code}: ${normalized.message}`);
      for (const [key, value] of Object.entries(normalized.details)) {
        console.error(`${key.toUpperCase()}=${value}`);
      }
      process.exitCode = 1;
    });
}
