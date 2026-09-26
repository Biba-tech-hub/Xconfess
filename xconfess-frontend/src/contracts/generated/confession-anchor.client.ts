/**
 * Auto-generated ABI client binding for ConfessionAnchor contract.
 * Generated from xconfess-contracts/contracts/confession-anchor/abi.json.
 */

export const CONFESSION_ANCHOR_EVENT_SCHEMA_VERSION = 1;
export const CONFESSION_ANCHOR_ERROR_REGISTRY_VERSION = 1;
export const CONFESSION_ANCHOR_ABI_VERSION = '0.1.0';

export interface ConfessionAnchorClientOptions {
  contractId: string;
  rpcUrl?: string;
}

export class ConfessionAnchorClient {
  readonly contractId: string;
  readonly eventSchemaVersion = CONFESSION_ANCHOR_EVENT_SCHEMA_VERSION;
  readonly abiVersion = CONFESSION_ANCHOR_ABI_VERSION;

  constructor(options: ConfessionAnchorClientOptions) {
    this.contractId = options.contractId;
  }

  async verifyConfession(contentHash: string): Promise<number | null> {
    // Client binding for reading confession verification timestamp
    return null;
  }

  async getConfessionCount(): Promise<number> {
    return 0;
  }

  async isPaused(): Promise<boolean> {
    return false;
  }

  async getEventSchemaVersion(): Promise<number> {
    return CONFESSION_ANCHOR_EVENT_SCHEMA_VERSION;
  }
}
