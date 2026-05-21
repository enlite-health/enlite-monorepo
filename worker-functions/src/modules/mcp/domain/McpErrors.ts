export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAuthError';
  }
}

export class McpCapabilityNotAllowedError extends Error {
  constructor(
    public readonly principal: string,
    public readonly capability: string,
  ) {
    super(`Capability "${capability}" not allowed for principal "${principal}"`);
    this.name = 'McpCapabilityNotAllowedError';
  }
}

export class McpOnBehalfOfMismatchError extends Error {
  constructor() {
    super('X-On-Behalf-Of-Worker-Id header does not match args.workerId');
    this.name = 'McpOnBehalfOfMismatchError';
  }
}

export class McpPrincipalNotFoundError extends Error {
  constructor(public readonly principalName: string) {
    super(`Service principal "${principalName}" not found in Secret Manager`);
    this.name = 'McpPrincipalNotFoundError';
  }
}

export class RateLimitExceededError extends Error {
  constructor(
    public readonly capability: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Rate limit exceeded for ${capability}. Retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitExceededError';
  }
}
