/**
 * Auto-generated ABI client binding for ReputationBadges contract.
 * Generated from xconfess-contracts/contracts/reputation-badges/abi.json.
 */

export const REPUTATION_BADGES_EVENT_SCHEMA_VERSION = 1;
export const REPUTATION_BADGES_ERROR_REGISTRY_VERSION = 1;
export const REPUTATION_BADGES_ABI_VERSION = '0.0.0';

export interface ReputationBadgesClientOptions {
  contractId: string;
  rpcUrl?: string;
}

export class ReputationBadgesClient {
  readonly contractId: string;
  readonly eventSchemaVersion = REPUTATION_BADGES_EVENT_SCHEMA_VERSION;
  readonly abiVersion = REPUTATION_BADGES_ABI_VERSION;

  constructor(options: ReputationBadgesClientOptions) {
    this.contractId = options.contractId;
  }

  async getUserReputation(user: string): Promise<bigint> {
    return BigInt(0);
  }

  async isPaused(): Promise<boolean> {
    return false;
  }
}
