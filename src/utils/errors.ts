export class XcDotError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number | boolean>;

  constructor(
    code: string,
    message: string,
    details: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = 'XcDotError';
    this.code = code;
    this.details = details;
  }
}

export class RpcUnavailableError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('RPC_UNAVAILABLE', message, details);
    this.name = 'RpcUnavailableError';
  }
}

export class WrongChainError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('WRONG_CHAIN', message, details);
    this.name = 'WrongChainError';
  }
}

export class BlockNotFoundError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('BLOCK_NOT_FOUND', message, details);
    this.name = 'BlockNotFoundError';
  }
}

export class BlockHashMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('BLOCK_HASH_MISMATCH', message, details);
    this.name = 'BlockHashMismatchError';
  }
}

export class StateRootMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('STATE_ROOT_MISMATCH', message, details);
    this.name = 'StateRootMismatchError';
  }
}

export class AssetNotFoundError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('ASSET_NOT_FOUND', message, details);
    this.name = 'AssetNotFoundError';
  }
}

export class AssetIdentityMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('ASSET_IDENTITY_MISMATCH', message, details);
    this.name = 'AssetIdentityMismatchError';
  }
}

export class EnumerationUnsupportedError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('RPC_UNSUPPORTED_STORAGE_ENUMERATION', message, details);
    this.name = 'EnumerationUnsupportedError';
  }
}

export class StorageDecodeError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('STORAGE_DECODE_ERROR', message, details);
    this.name = 'StorageDecodeError';
  }
}

export class DuplicateHolderError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('DUPLICATE_HOLDER', message, details);
    this.name = 'DuplicateHolderError';
  }
}

export class SupplyMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUPPLY_MISMATCH', message, details);
    this.name = 'SupplyMismatchError';
  }
}

export class AccountCountMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('ACCOUNT_COUNT_MISMATCH', message, details);
    this.name = 'AccountCountMismatchError';
  }
}

export class EvmBalanceMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('EVM_BALANCE_MISMATCH', message, details);
    this.name = 'EvmBalanceMismatchError';
  }
}

export class CanonicalSerializationError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('CANONICAL_SERIALIZATION_ERROR', message, details);
    this.name = 'CanonicalSerializationError';
  }
}

export class EvidenceCaptureError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('EVIDENCE_CAPTURE_FAILED', message, details);
    this.name = 'EvidenceCaptureError';
  }
}

export class EvidenceBackendUnsupportedError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('EVIDENCE_BACKEND_UNSUPPORTED', message, details);
    this.name = 'EvidenceBackendUnsupportedError';
  }
}

export class EvidenceVerificationError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('EVIDENCE_VERIFICATION_FAILED', message, details);
    this.name = 'EvidenceVerificationError';
  }
}

export function asXcDotError(error: unknown): XcDotError {
  if (error instanceof XcDotError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new XcDotError('UNEXPECTED_ERROR', message);
}
