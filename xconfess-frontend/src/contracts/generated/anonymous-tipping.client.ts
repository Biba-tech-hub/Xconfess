/**
 * Auto-generated ABI client binding for AnonymousTipping contract.
 * Generated from xconfess-contracts/contracts/anonymous-tipping/abi.json.
 */

export const ANONYMOUS_TIPPING_EVENT_SCHEMA_VERSION = 1;
export const ANONYMOUS_TIPPING_ERROR_REGISTRY_VERSION = 1;
export const ANONYMOUS_TIPPING_ABI_VERSION = '1.0.0';

export interface AnonymousTippingClientOptions {
  contractId: string;
  rpcUrl?: string;
}

export class AnonymousTippingClient {
  readonly contractId: string;
  readonly eventSchemaVersion = ANONYMOUS_TIPPING_EVENT_SCHEMA_VERSION;
  readonly abiVersion = ANONYMOUS_TIPPING_ABI_VERSION;

  constructor(options: AnonymousTippingClientOptions) {
    this.contractId = options.contractId;
  }

  async getTips(recipient: string): Promise<bigint> {
    return BigInt(0);
  }

  async isPaused(): Promise<boolean> {
    return false;
  }

  async latestSettlementNonce(): Promise<number> {
    return 0;
  }
}
