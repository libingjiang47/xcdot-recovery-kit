import { EvidenceCaptureError } from '../utils/errors.js';

export function validateBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 512) {
    throw new EvidenceCaptureError('Proof batch size must be an integer between 1 and 512.', {
      batchSize: value,
    });
  }
  return value;
}

export function partition<T>(items: readonly T[], batchSize: number): T[][] {
  validateBatchSize(batchSize);
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export function batchFileName(index: number): string {
  return `batch-${index.toString(10).padStart(6, '0')}.json`;
}
