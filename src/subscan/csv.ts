import { sha256Hex } from '../snapshot/digest.js';
import {
  SubscanBalancePrecisionError,
  SubscanInvalidAddressError,
  SubscanInvalidBalanceError,
  SubscanSchemaUnsupportedError,
} from '../utils/errors.js';
import { XC_DOT_DECIMALS } from '../asset/constants.js';

export const SUBSCAN_HEADERS = ['Rank', 'Account', 'Balance'] as const;

export interface ParsedCsvPage {
  headers: string[];
  records: string[][];
  schemaFingerprint: string;
}

function csvError(file: string, message: string): SubscanSchemaUnsupportedError {
  return new SubscanSchemaUnsupportedError(message, { sourceFile: file });
}

/** Parse RFC 4180 records without treating commas or quoted newlines as delimiters. */
export function parseRfc4180(text: string, file: string): string[][] {
  const input = text.startsWith('\ufeff') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let justClosedQuote = false;

  const finishField = (): void => {
    record.push(field);
    field = '';
    justClosedQuote = false;
  };
  const finishRecord = (): void => {
    finishField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (justClosedQuote) {
      if (character === ',') {
        finishField();
      } else if (character === '\r' || character === '\n') {
        finishRecord();
        if (character === '\r' && input[index + 1] === '\n') index += 1;
      } else {
        throw csvError(file, 'Unexpected data after a closing CSV quote.');
      }
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
    } else if (character === ',') {
      finishField();
    } else if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && input[index + 1] === '\n') index += 1;
    } else {
      field += character;
    }
  }

  if (quoted) throw csvError(file, 'Unterminated quoted CSV field.');
  if (justClosedQuote || field !== '' || record.length > 0) finishRecord();
  return records;
}

export function parseSubscanPage(text: string, file: string): ParsedCsvPage {
  const records = parseRfc4180(text, file);
  const headers = records.shift();
  if (!headers || headers.length !== SUBSCAN_HEADERS.length) {
    throw csvError(file, 'Unsupported Subscan CSV header or column count.');
  }
  for (let index = 0; index < SUBSCAN_HEADERS.length; index += 1) {
    if (headers[index] !== SUBSCAN_HEADERS[index]) {
      throw csvError(file, 'Unsupported Subscan CSV schema.');
    }
  }
  for (const record of records) {
    if (record.every((value) => value === '')) continue;
    if (record.length !== SUBSCAN_HEADERS.length) {
      throw csvError(file, 'A Subscan CSV row has an unexpected column count.');
    }
  }
  return {
    headers,
    records,
    schemaFingerprint: sha256Hex(JSON.stringify(headers)),
  };
}

export function parseSubscanAddress(
  rawAddress: string,
  sourceFile: string,
  sourceRow: number,
): string {
  const value = rawAddress.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new SubscanInvalidAddressError('Subscan Account is not a valid H160.', {
      sourceFile,
      sourceRow,
      rawValue: rawAddress,
    });
  }
  return value.toLowerCase();
}

export function parseSubscanBalance(
  rawBalance: string,
  sourceFile: string,
  sourceRow: number,
): string {
  const value = rawBalance.trim();
  if (/^-/.test(value)) {
    throw new SubscanInvalidBalanceError('Subscan Balance must be unsigned.', {
      sourceFile,
      sourceRow,
      rawValue: rawBalance,
    });
  }
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new SubscanInvalidBalanceError('Subscan Balance is not an exact decimal integer.', {
      sourceFile,
      sourceRow,
      rawValue: rawBalance,
    });
  }
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > XC_DOT_DECIMALS) {
    throw new SubscanBalancePrecisionError(
      `Subscan Balance has more than ${XC_DOT_DECIMALS} fractional digits.`,
      { sourceFile, sourceRow, rawValue: rawBalance },
    );
  }
  const normalizedWhole = whole.replaceAll(',', '').replace(/^0+(?=\d)/, '');
  const paddedFraction = fraction.padEnd(XC_DOT_DECIMALS, '0');
  return (
    BigInt(normalizedWhole) * 10n ** BigInt(XC_DOT_DECIMALS) +
    BigInt(paddedFraction)
  ).toString(10);
}
