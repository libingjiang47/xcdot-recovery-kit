#!/usr/bin/env node
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { asXcDotError } from '../utils/errors.js';
import { buildReleaseCommand } from './build-release.js';
import { captureReleaseProofsCommand } from './capture-release-proofs.js';
import { verifyReleaseCommand } from './verify-release.js';
import { refreshReleaseSumsCommand } from './refresh-release-sums.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('xcdot-recovery')
    .description('Deterministic xcDOT state extraction and verification toolkit')
    .version('0.26.0')
    .showSuggestionAfterError();
  program.addCommand(buildReleaseCommand());
  program.addCommand(captureReleaseProofsCommand());
  program.addCommand(verifyReleaseCommand());
  program.addCommand(refreshReleaseSumsCommand());
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
