/**
 * Auto-generated ABI client binding for ConfessionRegistry contract.
 * Generated from xconfess-contracts/contracts/confession-registry/abi.json.
 */

export const CONFESSION_REGISTRY_EVENT_SCHEMA_VERSION = 1;
export const CONFESSION_REGISTRY_ERROR_REGISTRY_VERSION = 1;
export const CONFESSION_REGISTRY_ABI_VERSION = '0.1.0';

export interface ConfessionRegistryClientOptions {
  contractId: string;
  rpcUrl?: string;
}

export class ConfessionRegistryClient {
  readonly contractId: string;
  readonly eventSchemaVersion = CONFESSION_REGISTRY_EVENT_SCHEMA_VERSION;
  readonly abiVersion = CONFESSION_REGISTRY_ABI_VERSION;

  constructor(options: ConfessionRegistryClientOptions) {
    this.contractId = options.contractId;
  }

  async getTotalCount(): Promise<number> {
    return 0;
  }

  async schemaVersion(): Promise<number> {
    return 2;
  }
}
