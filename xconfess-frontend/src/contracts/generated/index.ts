export * from './confession-anchor.client';
export * from './confession-registry.client';
export * from './anonymous-tipping.client';
export * from './reputation-badges.client';

export interface ContractCompatibilityCheck {
  supportedSchemaVersion: number;
  deployedSchemaVersion: number;
  isCompatible: boolean;
}

export function verifyEventSchemaCompatibility(
  expectedVersion: number,
  actualVersion: number,
): ContractCompatibilityCheck {
  return {
    supportedSchemaVersion: expectedVersion,
    deployedSchemaVersion: actualVersion,
    isCompatible: actualVersion <= expectedVersion,
  };
}
