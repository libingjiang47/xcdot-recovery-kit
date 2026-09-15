import { keccak256, type Address, type Hex } from 'viem';
import { TERMINAL_MOONBEAM_PRECOMPILES } from '../final-state/constants.js';
import type { AccountClassification, CodeStatus, HolderRecord } from '../types.js';
import { withConcurrency } from './providers.js';
import { compareCanonicalStrings } from '../utils/order.js';

interface CodeClient {
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
}

export interface ClassificationError {
  address: string;
  attempt: number;
  errorType: string;
  message: string;
}

export interface ClassifyHolderOptions {
  retries?: number;
  onResult?: (result: AccountClassification) => Promise<void> | void;
  onError?: (error: ClassificationError) => Promise<void> | void;
}

const PRECOMPILE_SOURCE = 'moonbeam-runtime-4401-precompile-set';
const CODE_SOURCE = 'eth_getCode at pinned EVM block 16796696';

function unknownResult(address: string): AccountClassification {
  return {
    address,
    codeStatus: 'unknown',
    classification: 'unknown',
    source: CODE_SOURCE,
  };
}

function errorDescription(error: unknown): { errorType: string; message: string } {
  if (error instanceof Error)
    return { errorType: error.name || 'Error', message: error.message || String(error) };
  return { errorType: typeof error, message: String(error) };
}

async function classifyOne(
  client: CodeClient,
  holder: HolderRecord,
  blockNumber: bigint,
  retries: number,
  onError: (error: ClassificationError) => Promise<void> | void,
): Promise<AccountClassification> {
  const address = holder.address.toLowerCase();
  if (TERMINAL_MOONBEAM_PRECOMPILES.has(address)) {
    return {
      address,
      codeStatus: 'system_precompile',
      classification: 'system-precompile',
      source: PRECOMPILE_SOURCE,
    };
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const code = await client.getCode({ address: address as Address, blockNumber });
      if (code === '0x') {
        return {
          address,
          codeStatus: 'no_code' satisfies CodeStatus,
          classification: 'no-code',
          source: CODE_SOURCE,
          codeSize: 0,
        };
      }
      if (!code) {
        await onError({
          address,
          attempt,
          errorType: 'EmptyCodeResult',
          message: 'eth_getCode returned no value at the pinned block.',
        });
        return unknownResult(address);
      }
      return {
        address,
        codeStatus: 'has_code' satisfies CodeStatus,
        classification: 'code-present',
        source: CODE_SOURCE,
        codeSize: (code.length - 2) / 2,
        codeHash: keccak256(code),
      };
    } catch (error) {
      if (attempt === retries) {
        const description = errorDescription(error);
        await onError({ address, attempt, ...description });
        return unknownResult(address);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
    }
  }
  return unknownResult(address);
}

export async function classifyHolderAccounts(
  client: CodeClient,
  holders: readonly HolderRecord[],
  blockNumber: bigint,
  concurrency: number,
  options: ClassifyHolderOptions = {},
): Promise<AccountClassification[]> {
  const result: AccountClassification[] = [];
  const retries = options.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 1 || retries > 5)
    throw new Error('Classification retries must be an integer between 1 and 5.');
  const onResult = options.onResult ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  await withConcurrency(holders, concurrency, async (holder) => {
    const classified = await classifyOne(client, holder, blockNumber, retries, onError);
    result.push(classified);
    await onResult(classified);
  });
  return result.sort((a, b) => compareCanonicalStrings(a.address, b.address));
}
