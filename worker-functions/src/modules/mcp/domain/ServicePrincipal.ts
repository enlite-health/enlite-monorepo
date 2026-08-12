/**
 * Service principal que pode invocar o MCP server.
 * Carregado do Secret Manager em runtime; allowlist por principal.
 */
export interface ServicePrincipalProps {
  name: string;                   // ex: "triage-service"
  allowedCapabilities: string[];  // ex: ["worker.profile.get", "worker.documents.upload"]
  tokenHashes: string[];          // sha256 hex dos tokens ativos (multi-version)
  /**
   * Expõe as tools com nomes claude-safe (pontos → underscores).
   * O claude.ai valida nomes com ^[a-zA-Z0-9_-]{1,64}$ e rejeita pontos;
   * consumidores internos (triage) continuam vendo os nomes canônicos.
   */
  sanitizedToolNames?: boolean;
}

export class ServicePrincipal {
  constructor(private readonly props: ServicePrincipalProps) {
    if (!props.name) throw new Error('ServicePrincipal: name required');
    if (!Array.isArray(props.allowedCapabilities)) {
      throw new Error('ServicePrincipal: allowedCapabilities required');
    }
    if (!Array.isArray(props.tokenHashes) || props.tokenHashes.length === 0) {
      throw new Error('ServicePrincipal: at least one tokenHash required');
    }
  }

  get name(): string {
    return this.props.name;
  }

  get allowedCapabilities(): readonly string[] {
    return this.props.allowedCapabilities;
  }

  get sanitizedToolNames(): boolean {
    return this.props.sanitizedToolNames ?? false;
  }

  isCapabilityAllowed(capability: string): boolean {
    return this.props.allowedCapabilities.includes(capability);
  }

  /**
   * Verifica se um token (em plaintext) corresponde a algum dos tokens ativos.
   * Usa hash SHA256 + comparação constant-time.
   */
  matchesToken(token: string, hashFn: (s: string) => string): boolean {
    const candidateHash = hashFn(token);
    // Constant-time-like — itera todos os hashes (não early-return na primeira diferença)
    let match = false;
    for (const validHash of this.props.tokenHashes) {
      if (timingSafeEqual(candidateHash, validHash)) {
        match = true;
      }
    }
    return match;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
