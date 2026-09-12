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

export class SubscanFileCountMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_FILE_COUNT_MISMATCH', message, details);
    this.name = 'SubscanFileCountMismatchError';
  }
}

export class SubscanSchemaUnsupportedError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_SCHEMA_UNSUPPORTED', message, details);
    this.name = 'SubscanSchemaUnsupportedError';
  }
}

export class SubscanSchemaMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_SCHEMA_MISMATCH', message, details);
    this.name = 'SubscanSchemaMismatchError';
  }
}

export class SubscanInvalidAddressError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_INVALID_ADDRESS', message, details);
    this.name = 'SubscanInvalidAddressError';
  }
}

export class SubscanInvalidBalanceError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_INVALID_BALANCE', message, details);
    this.name = 'SubscanInvalidBalanceError';
  }
}

export class SubscanBalancePrecisionError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_BALANCE_PRECISION', message, details);
    this.name = 'SubscanBalancePrecisionError';
  }
}

export class SubscanDuplicateFileError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_DUPLICATE_FILE', message, details);
    this.name = 'SubscanDuplicateFileError';
  }
}

export class SubscanSemanticDuplicatePageError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_SEMANTIC_DUPLICATE_PAGE', message, details);
    this.name = 'SubscanSemanticDuplicatePageError';
  }
}

export class SubscanDuplicateBalanceConflictError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_DUPLICATE_BALANCE_CONFLICT', message, details);
    this.name = 'SubscanDuplicateBalanceConflictError';
  }
}

export class SubscanImportIntegrityError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_IMPORT_INTEGRITY', message, details);
    this.name = 'SubscanImportIntegrityError';
  }
}

export class SubscanFinalStateVerificationError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_FINAL_STATE_VERIFICATION', message, details);
    this.name = 'SubscanFinalStateVerificationError';
  }
}

export class FinalStateResumeContextMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_RESUME_CONTEXT_MISMATCH', message, details);
    this.name = 'FinalStateResumeContextMismatchError';
  }
}

export class FinalStateBalanceConflictError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_BALANCE_CONFLICT', message, details);
    this.name = 'FinalStateBalanceConflictError';
  }
}

export class FinalStateDiscoveryPartialError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSCAN_DISCOVERY_PARTIAL', message, details);
    this.name = 'FinalStateDiscoveryPartialError';
  }
}

export class FinalStateSupplyChangedError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_SUPPLY_CHANGED', message, details);
    this.name = 'FinalStateSupplyChangedError';
  }
}

export class FinalStateIdentityMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_IDENTITY_MISMATCH', message, details);
    this.name = 'FinalStateIdentityMismatchError';
  }
}

export class FinalStateOutputExistsError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_OUTPUT_EXISTS', message, details);
    this.name = 'FinalStateOutputExistsError';
  }
}

export class FinalStateStorageLayoutError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('EVM_STORAGE_LAYOUT_MISMATCH', message, details);
    this.name = 'FinalStateStorageLayoutError';
  }
}

export class FinalStateStorageBackendUnsupportedError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('EVM_STORAGE_BACKEND_UNSUPPORTED', message, details);
    this.name = 'FinalStateStorageBackendUnsupportedError';
  }
}

export class FinalStateSupplyShortfallError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_SUPPLY_SHORTFALL', message, details);
    this.name = 'FinalStateSupplyShortfallError';
  }
}

export class FinalStateSupplyOverflowError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('FINAL_STATE_SUPPLY_OVERFLOW', message, details);
    this.name = 'FinalStateSupplyOverflowError';
  }
}

export class SubstrateArchiveProbeInputError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('SUBSTRATE_ARCHIVE_PROBE_INPUT', message, details);
    this.name = 'SubstrateArchiveProbeInputError';
  }
}

export class Rank565DiagnosticError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('RANK565_DIAGNOSTIC_FAILED', message, details);
    this.name = 'Rank565DiagnosticError';
  }
}

export class Rank565ResumeContextMismatchError extends XcDotError {
  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super('RANK565_RESUME_CONTEXT_MISMATCH', message, details);
    this.name = 'Rank565ResumeContextMismatchError';
  }
}

export function asXcDotError(error: unknown): XcDotError {
  if (error instanceof XcDotError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new XcDotError('UNEXPECTED_ERROR', message);
}
