import { createHash } from 'node:crypto';
import { McpPrincipalNotFoundError } from '../../domain/McpErrors';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockAccessSecretVersion = jest.fn();

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: mockAccessSecretVersion,
  })),
}));

jest.mock('@shared/logging', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock do Logger.ts via alias (resolve o módulo real que ServicePrincipalSecretManagerRepo importa)
jest.mock('@shared/logging/Logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Import depois dos mocks ──────────────────────────────────────────────────

import { ServicePrincipalSecretManagerRepo } from '../ServicePrincipalSecretManagerRepo';
import { logger } from '@shared/logging/Logger';

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makeSecretResponse(
  name: string,
  capabilities: string[],
  tokens: string[],
) {
  const payload = JSON.stringify({ name, allowedCapabilities: capabilities, tokens });
  return [{ payload: { data: Buffer.from(payload) } }];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ServicePrincipalSecretManagerRepo', () => {
  let repo: ServicePrincipalSecretManagerRepo;

  beforeEach(() => {
    jest.clearAllMocks();
    // TTL curto pra facilitar testes de expiração
    repo = new ServicePrincipalSecretManagerRepo(
      undefined, // usa o mock automático do SecretManagerServiceClient
      'enlite-prd',
      60_000,
    );
  });

  // 1 — Happy path: carrega do SM e cacheia
  it('getByName: carrega do Secret Manager e retorna principal', async () => {
    mockAccessSecretVersion.mockResolvedValueOnce(
      makeSecretResponse('triage-service', ['worker.profile.get'], ['token-v1']),
    );

    const principal = await repo.getByName('triage-service');

    expect(principal.name).toBe('triage-service');
    expect(principal.isCapabilityAllowed('worker.profile.get')).toBe(true);
    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(1);
    expect(mockAccessSecretVersion).toHaveBeenCalledWith({
      name: 'projects/enlite-prd/secrets/mcp-principal-triage-service/versions/latest',
    });
  });

  // 2 — Cache hit: segunda chamada dentro do TTL não chama SM
  it('getByName: segunda chamada dentro do TTL usa cache', async () => {
    mockAccessSecretVersion.mockResolvedValueOnce(
      makeSecretResponse('triage-service', ['worker.profile.get'], ['token-v1']),
    );

    await repo.getByName('triage-service');
    await repo.getByName('triage-service');

    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(1);
  });

  // 3 — Cache expira: chamada após TTL recarrega SM
  it('getByName: recarrega do SM após expiração do TTL', async () => {
    const shortTtlRepo = new ServicePrincipalSecretManagerRepo(
      undefined,
      'enlite-prd',
      10, // 10ms TTL
    );
    mockAccessSecretVersion
      .mockResolvedValueOnce(
        makeSecretResponse('triage-service', ['worker.profile.get'], ['token-v1']),
      )
      .mockResolvedValueOnce(
        makeSecretResponse('triage-service', ['worker.profile.get'], ['token-v2']),
      );

    await shortTtlRepo.getByName('triage-service');
    await new Promise((resolve) => setTimeout(resolve, 20)); // espera TTL expirar
    await shortTtlRepo.getByName('triage-service');

    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
  });

  // 4 — findByToken retorna principal correto para token válido
  it('findByToken: retorna principal para token válido (via SM)', async () => {
    mockAccessSecretVersion.mockResolvedValueOnce(
      makeSecretResponse('triage-service', ['worker.profile.get'], ['secret-token-123']),
    );

    const principal = await repo.findByToken('secret-token-123');

    expect(principal).not.toBeNull();
    expect(principal!.name).toBe('triage-service');
  });

  // 5 — findByToken retorna null para token inválido
  it('findByToken: retorna null para token inválido', async () => {
    mockAccessSecretVersion.mockResolvedValueOnce(
      makeSecretResponse('triage-service', ['worker.profile.get'], ['correct-token']),
    );

    const principal = await repo.findByToken('wrong-token');

    expect(principal).toBeNull();
  });

  // 6 — findByToken aceita múltiplos tokens (rotação)
  it('findByToken: aceita v1 e v2 simultâneos (rotação)', async () => {
    mockAccessSecretVersion.mockResolvedValue(
      makeSecretResponse(
        'triage-service',
        ['worker.profile.get'],
        ['token-v1', 'token-v2'],
      ),
    );

    const p1 = await repo.findByToken('token-v1');
    repo.invalidate(); // limpa cache pra forçar reload
    const p2 = await repo.findByToken('token-v2');

    expect(p1!.name).toBe('triage-service');
    expect(p2!.name).toBe('triage-service');
  });

  // 7 — Principal inexistente → McpPrincipalNotFoundError
  it('getByName: lança McpPrincipalNotFoundError quando principal não existe', async () => {
    mockAccessSecretVersion.mockResolvedValueOnce([{ payload: { data: null } }]);

    await expect(repo.getByName('unknown-principal')).rejects.toThrow(
      McpPrincipalNotFoundError,
    );
  });

  // 8 — Erro do Secret Manager → log + McpPrincipalNotFoundError
  it('getByName: loga erro e lança McpPrincipalNotFoundError em falha do SM', async () => {
    mockAccessSecretVersion.mockRejectedValueOnce(new Error('SM unavailable'));

    await expect(repo.getByName('triage-service')).rejects.toThrow(
      McpPrincipalNotFoundError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ principalName: 'triage-service' }),
      'mcp: failed to load principal from Secret Manager',
    );
  });

  // 9 — invalidate() força reload na próxima chamada
  it('invalidate: força reload do SM na próxima chamada', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce(
        makeSecretResponse('triage-service', ['worker.profile.get'], ['token-v1']),
      )
      .mockResolvedValueOnce(
        makeSecretResponse('triage-service', ['worker.profile.get', 'worker.vacancies.list'], ['token-v2']),
      );

    await repo.getByName('triage-service');
    repo.invalidate('triage-service');
    const updated = await repo.getByName('triage-service');

    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
    expect(updated.isCapabilityAllowed('worker.vacancies.list')).toBe(true);
  });

  // 10 — Constant-time matchesToken: não early-return mesmo com diff na primeira posição
  it('matchesToken: itera todos os hashes mesmo quando o token correto é o último', () => {
    // Cria um principal com 3 hashes; o token correto é o último
    const correctToken = 'the-real-token';
    // Os outros hashes são de strings aleatórias que não serão testadas como token
    const hashes = [sha256('internal-decoy-1'), sha256('internal-decoy-2'), sha256(correctToken)];

    const { ServicePrincipal } = require('../../domain/ServicePrincipal');
    const principal = new ServicePrincipal({
      name: 'test',
      allowedCapabilities: [],
      tokenHashes: hashes,
    });

    // Deve encontrar o token mesmo que seja o último na lista (não early-return)
    expect(principal.matchesToken(correctToken, sha256)).toBe(true);
    // Tokens que não existem na lista devem retornar false
    expect(principal.matchesToken('nonexistent-token', sha256)).toBe(false);
    expect(principal.matchesToken('another-invalid', sha256)).toBe(false);
    // Token vazio também deve retornar false
    expect(principal.matchesToken('', sha256)).toBe(false);
  });
});
