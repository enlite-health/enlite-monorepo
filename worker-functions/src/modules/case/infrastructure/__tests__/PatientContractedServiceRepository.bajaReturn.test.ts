/**
 * TESTE-CHAVE (a) da spec 084 / R17 — a reativação do serviço devolve a vaga baixada POR ELE, e só ela.
 *
 * Se alguém quebrar a volta (apagar o ramo `active: true`, trocar o filtro de motivo, esquecer a auditoria ou o
 * Talentum), este arquivo falha. A prova com SQL real (a vaga baixada à mão NÃO volta) é o e2e `084-vagas-antigas`.
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));
jest.mock('@shared/database/requestDbSession', () => ({
  ...jest.requireActual('@shared/database/requestDbSession'),
  withSystemDbContext: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
jest.mock('@shared/logging', () => ({ ...jest.requireActual('@shared/logging'), reportError: jest.fn() }));

import { PatientContractedServiceRepository } from '../PatientContractedServiceRepository';
import type { ContractedServiceProviderRepository } from '../ContractedServiceProviderRepository';

const NOW = new Date('2026-11-04T15:00:00Z');
const SERVICE_ROW = {
  id: 'svc-1', patient_id: 'pat-1', service_code: 'AT', providers_needed: 1, address_id: null, schedule: null,
  active: true, ended_at: null, country: 'AR', created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z',
};
const providerRepo = () => ({ listForService: jest.fn().mockResolvedValue([]) }) as unknown as ContractedServiceProviderRepository;
const NO_DERIVATION = { run: jest.fn(async () => 'unchanged' as const) };

function cliente(jobPostingsRows: { baixa?: unknown[]; volta?: unknown[] }) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/^UPDATE job_postings SET status_before_baja = status/.test(sql)) return { rows: jobPostingsRows.baixa ?? [], rowCount: (jobPostingsRows.baixa ?? []).length };
    if (/^UPDATE job_postings SET status = COALESCE\(status_before_baja/.test(sql)) return { rows: jobPostingsRows.volta ?? [], rowCount: (jobPostingsRows.volta ?? []).length };
    if (/^SELECT \* FROM patient_contracted_services WHERE id/.test(sql)) return { rows: [SERVICE_ROW], rowCount: 1 };
    if (/^UPDATE patient_contracted_services SET/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('PatientContractedServiceRepository — a ÚNICA volta de vaga baixada (R17/P2/P6/F4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it('reativar o serviço devolve SÓ a vaga baixada por ele: filtro baja_reason = SERVICE, auditoria e retomada no Talentum', async () => {
    const { cli, chamadas } = cliente({ volta: [{ id: 'v-volta', status: 'SEARCHING' }] });
    mockConnect.mockResolvedValue(cli);
    const audit = { logEventSafe: jest.fn(async () => undefined) };
    const talentum = { pause: jest.fn(async () => []), resume: jest.fn(async () => []) };
    const repo = new PatientContractedServiceRepository(providerRepo(), undefined, NO_DERIVATION, talentum, audit);

    await repo.update('svc-1', { active: true, actorUid: 'uid-9' }, NOW);
    await tick();

    const volta = chamadas.find((c) => /status = COALESCE\(status_before_baja/.test(c.sql));
    expect(volta).toBeDefined();
    // Vaga baixada à mão (MANUAL) ou pelo corte (CUTOFF) NUNCA volta: o motivo SERVICE é o filtro, não enfeite.
    expect(volta?.sql).toContain(`baja_reason = 'SERVICE'`);
    expect(volta?.sql).toContain(`status = 'DE_BAJA'`);
    expect(volta?.sql).toContain('contracted_service_id = $1');
    expect(volta?.params).toEqual(['svc-1']);
    // P6: a volta vira registro de auditoria (quem, antes, depois).
    expect(audit.logEventSafe).toHaveBeenCalledWith(
      cli,
      expect.objectContaining({
        jobPostingId: 'v-volta',
        eventType: 'STATUS_CHANGED',
        actorUserId: 'uid-9',
        changes: { before: { status: 'DE_BAJA', baja_reason: 'SERVICE' }, after: { status: 'SEARCHING', baja_reason: null } },
      }),
    );
    // F4: o projeto do Talentum é RETOMADO (por API; 403 vai à lista manual, dentro do serviço).
    expect(talentum.resume).toHaveBeenCalledWith(['v-volta']);
    expect(talentum.pause).not.toHaveBeenCalled();
  });

  it('baixar o serviço grava o motivo SERVICE, audita e PAUSA (nunca apaga) o projeto no Talentum', async () => {
    const { cli, chamadas } = cliente({ baixa: [{ id: 'v-baixa', status_before_baja: 'SEARCHING' }] });
    mockConnect.mockResolvedValue(cli);
    const audit = { logEventSafe: jest.fn(async () => undefined) };
    const talentum = { pause: jest.fn(async () => []), resume: jest.fn(async () => []) };
    const repo = new PatientContractedServiceRepository(providerRepo(), undefined, NO_DERIVATION, talentum, audit);

    await repo.update('svc-1', { active: false, actorUid: 'uid-9' }, NOW);
    await tick();

    const baixa = chamadas.find((c) => /status_before_baja = status/.test(c.sql));
    expect(baixa?.sql).toContain(`baja_reason = 'SERVICE'`);
    expect(audit.logEventSafe).toHaveBeenCalledWith(
      cli,
      expect.objectContaining({
        jobPostingId: 'v-baixa',
        changes: { before: { status: 'SEARCHING', baja_reason: null }, after: { status: 'DE_BAJA', baja_reason: 'SERVICE' } },
      }),
    );
    expect(talentum.pause).toHaveBeenCalledWith(['v-baixa']);
    expect(talentum.resume).not.toHaveBeenCalled();
  });

  it('sem vaga afetada (serviço sem vaga, ou só vagas baixadas à mão): nada de auditoria nem de Talentum', async () => {
    const { cli } = cliente({ volta: [] });
    mockConnect.mockResolvedValue(cli);
    const audit = { logEventSafe: jest.fn(async () => undefined) };
    const talentum = { pause: jest.fn(async () => []), resume: jest.fn(async () => []) };
    const repo = new PatientContractedServiceRepository(providerRepo(), undefined, NO_DERIVATION, talentum, audit);
    await repo.update('svc-1', { active: true, actorUid: 'uid-9' }, NOW);
    await tick();
    expect(audit.logEventSafe).not.toHaveBeenCalled();
    expect(talentum.resume).not.toHaveBeenCalled();
  });

  it('falha do Talentum NUNCA desfaz o PATCH do serviço (efeito pós-commit, reportado)', async () => {
    const { cli } = cliente({ baixa: [{ id: 'v1', status_before_baja: 'SEARCHING' }] });
    mockConnect.mockResolvedValue(cli);
    const talentum = { pause: jest.fn(async () => { throw new Error('talentum fora'); }), resume: jest.fn() };
    const repo = new PatientContractedServiceRepository(providerRepo(), undefined, NO_DERIVATION, talentum, { logEventSafe: jest.fn() });
    await expect(repo.update('svc-1', { active: false, actorUid: 'uid-9' }, NOW)).resolves.not.toBeNull();
    await tick();
    expect(talentum.pause).toHaveBeenCalled();
  });
});
