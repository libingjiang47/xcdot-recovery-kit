import { createPublicClient, http, type PublicClient } from 'viem';
import { RpcUnavailableError, XcDotError } from '../utils/errors.js';

export function createEvmClient(rpc: string): PublicClient {
  if (!rpc) throw new RpcUnavailableError('An EVM RPC endpoint is required.');
  try {
    return createPublicClient({ transport: http(rpc) });
  } catch (error) {
    throw new RpcUnavailableError(`Could not create an EVM RPC client: ${String(error)}`, { rpc });
  }
}

export async function withConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Concurrency must be an integer between 1 and 100.');
  }
  let cursor = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

export async function retryRpc<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof XcDotError || attempt === attempts - 1) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw lastError;
}
