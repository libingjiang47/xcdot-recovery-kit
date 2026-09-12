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
import { importSubscanCommand } from './import-subscan.js';
import { verifySubscanFinalStateCommand } from './verify-subscan-final-state.js';
import { diagnoseRank565Command } from './diagnose-rank565.js';
import { reconstructFinalStateCommand } from './reconstruct-final-state.js';
import { inspectEvmStorageLayoutCommand } from './inspect-evm-storage-layout.js';
import { extractFinalStateStorageCommand } from './extract-final-state-storage.js';
import { probeSubstrateArchiveCommand } from './probe-substrate-archive.js';
import { probeSubstrateArchiveMatrixCommand } from './probe-substrate-archive-matrix.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('xcdot-recovery')
    .description('Deterministic xcDOT state extraction and verification toolkit')
    .version('0.26.0')
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
  program.addCommand(importSubscanCommand());
  program.addCommand(verifySubscanFinalStateCommand());
  program.addCommand(diagnoseRank565Command());
  program.addCommand(reconstructFinalStateCommand());
  program.addCommand(inspectEvmStorageLayoutCommand());
  program.addCommand(extractFinalStateStorageCommand());
  program.addCommand(probeSubstrateArchiveCommand());
  program.addCommand(probeSubstrateArchiveMatrixCommand());
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
