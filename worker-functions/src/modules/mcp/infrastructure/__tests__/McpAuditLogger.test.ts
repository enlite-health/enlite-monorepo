// ── Mocks ───────────────────────────────────────────────────────────────────

const mockLoggerInfo = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock do Logger.ts via alias (resolve o módulo real que McpAuditLogger importa)
jest.mock('@shared/logging/Logger', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Import depois dos mocks ──────────────────────────────────────────────────

import { McpAuditLogger } from '../McpAuditLogger';
import type { McpAuditEvent } from '../../domain/McpAuditEvent';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('McpAuditLogger', () => {
  let auditLogger: McpAuditLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    auditLogger = new McpAuditLogger();
  });

  // 1 — CPF redactado
  it('redact: CPF → ***last4', () => {
    const result = auditLogger.redact({ cpf: '12345678900' });
    expect(result.cpf).toBe('***8900');
  });

  // 2 — RG redactado
  it('redact: RG → ***last4', () => {
    const result = auditLogger.redact({ rg: '1234567' });
    expect(result.rg).toBe('***4567');
  });

  // 3 — Email redactado: domínio preservado, local part oculto
  it('redact: email → ***@dominio.com', () => {
    const result = auditLogger.redact({ email: 'gabriel@enlite.com' });
    expect(result.email).toBe('***@enlite.com');
  });

  // 4 — Email malformado → '***'
  it('redact: email malformado → ***', () => {
    const result = auditLogger.redact({ email: 'not-an-email' });
    expect(result.email).toBe('***');
  });

  // 5 — Phone redactado
  it('redact: phone → ***last4', () => {
    const result = auditLogger.redact({ phone: '+5511987654321' });
    expect(result.phone).toBe('***4321');
  });

  // 6 — birthDate: apenas ano
  it('redact: birthDate → apenas ano', () => {
    const result = auditLogger.redact({ birthDate: '1990-05-15' });
    expect(result.birthDate).toBe('1990');
  });

  // 7 — mediaUrl: strip query string
  it('redact: mediaUrl → sem query string', () => {
    const result = auditLogger.redact({
      mediaUrl: 'https://api.twilio.com/2010/file.pdf?token=abc&expires=123',
    });
    expect(result.mediaUrl).toBe('https://api.twilio.com/2010/file.pdf');
  });

  // 8 — mediaUrl inválida → '***'
  it('redact: mediaUrl inválida → ***', () => {
    const result = auditLogger.redact({ mediaUrl: 'not-a-valid-url' });
    expect(result.mediaUrl).toBe('***');
  });

  // 9 — Recursão em objetos aninhados
  it('redact: recursão em objetos aninhados', () => {
    const result = auditLogger.redact({
      worker: { cpf: '98765432100', name: 'João' },
    });
    const inner = result.worker as Record<string, unknown>;
    expect(inner.cpf).toBe('***2100');
    // name não é campo PII listado — passa intacto
    expect(inner.name).toBe('João');
  });

  // 10 — Campos não-PII preservados
  it('redact: campos não-PII passam intactos', () => {
    const result = auditLogger.redact({
      documentType: 'resume_cv',
      workerId: 'worker-abc-123',
      count: 5,
    });
    expect(result.documentType).toBe('resume_cv');
    expect(result.workerId).toBe('worker-abc-123');
    expect(result.count).toBe(5);
  });

  // 11 — emit() chama logger.info com estrutura correta
  it('emit: chama logger.info com estrutura de audit correta', () => {
    const event: McpAuditEvent = {
      timestamp: '2026-05-20T12:00:00.000Z',
      principal: 'triage-service',
      onBehalfOfWorkerId: 'worker-xyz',
      capability: 'worker.profile.get',
      argsRedacted: { workerId: 'worker-xyz' },
      outcome: 'success',
      latencyMs: 42,
    };

    auditLogger.emit(event);

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const [logObject, message] = mockLoggerInfo.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe('mcp.audit.worker.profile.get');
    expect(logObject).toHaveProperty('audit');
    const audit = logObject.audit as Record<string, unknown>;
    expect(audit.principal).toBe('triage-service');
    expect(audit.capability).toBe('worker.profile.get');
    expect(audit.outcome).toBe('success');
    expect(audit.latencyMs).toBe(42);
  });

  // 12 — Campo PII com valor não-string → '***'
  it('redact: campo PII com valor não-string → ***', () => {
    const result = auditLogger.redact({ cpf: 12345678900, email: null });
    expect(result.cpf).toBe('***');
    expect(result.email).toBe('***');
  });

  // Extras de cobertura de boundary
  it('redact: CPF muito curto (< 4 chars) → ***', () => {
    const result = auditLogger.redact({ cpf: '12' });
    expect(result.cpf).toBe('***');
  });

  it('redact: externalUrl strip query string', () => {
    const result = auditLogger.redact({
      externalUrl: 'https://storage.googleapis.com/bucket/file.pdf?X-Goog-Signature=xyz',
    });
    expect(result.externalUrl).toBe('https://storage.googleapis.com/bucket/file.pdf');
  });

  it('redact: firstName e lastName → ***', () => {
    const result = auditLogger.redact({ firstName: 'Gabriel', lastName: 'Stein' });
    expect(result.firstName).toBe('***');
    expect(result.lastName).toBe('***');
  });

  it('redact: arrays não-PII passam intactos', () => {
    const result = auditLogger.redact({ tags: ['a', 'b'] });
    expect(result.tags).toEqual(['a', 'b']);
  });
});
