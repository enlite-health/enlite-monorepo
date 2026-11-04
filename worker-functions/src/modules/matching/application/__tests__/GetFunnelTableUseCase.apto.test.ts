/**
 * Spec 067 (FR-06/FR-08/FR-12, C2) — a tabela do funil (modo lista) e as contagens por aba leem o apto.
 * Completado sem apto cai em BLOQUEADO; a linha mantém `funnelStage` (etapa interna). Morre se o use case
 * ignorar `worker_apto` (passar `true` fixo) ou se o repositório deixar de projetar a coluna.
 */
const mockFetchRawRows = jest.fn();
const mockFetchBlockedRawRows = jest.fn().mockResolvedValue([]);
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.mock('../../infrastructure/FunnelTableRepository', () => ({
  ...jest.requireActual('../../infrastructure/FunnelTableRepository'),
  FunnelTableRepository: jest.fn().mockImplementation(() => ({
    fetchRawRows: mockFetchRawRows,
    fetchBlockedRawRows: mockFetchBlockedRawRows,
  })),
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: jest.fn().mockResolvedValue('Ficticio') })),
}));

import { GetFunnelTableUseCase } from '../GetFunnelTableUseCase';

function linha(id: string, stage: string, apto: boolean | null | undefined) {
  return {
    id, worker_id: `w-${id}`, first_name_encrypted: 'encrypted:a', last_name_encrypted: 'encrypted:b', worker_raw_name: null,
    email: null, phone: null, profile_photo_url_encrypted: null, invited_at: '2026-08-01T10:00:00Z',
    funnel_stage: stage, interview_response: null, wbdl_dispatched_at: null, wbdl_delivery_status: null, wbdl_status: null,
    worker_status: 'REGISTERED', contact_notes_count: 0, self_applied_at: null, source: 'talentum',
    messaged_at: '2026-08-01T10:00:00Z', is_blocked: false, distance_km: null,
    ...(apto === undefined ? {} : { worker_apto: apto }),
  };
}

describe('GetFunnelTableUseCase — apto (spec 067, C2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchBlockedRawRows.mockResolvedValue([]);
  });

  it('kanbanColumn: Completado apto → COMPLETED; não apto / null / coluna ausente → BLOQUEADO; funnelStage preservado (FR-12)', async () => {
    mockFetchRawRows.mockResolvedValue([
      linha('ok', 'QUALIFIED', true),
      linha('nao', 'QUALIFIED', false),
      linha('nulo', 'IN_DOUBT', null),
      linha('ausente', 'COMPLETED', undefined),
      linha('prog', 'IN_PROGRESS', null),
    ]);
    const { rows } = await new GetFunnelTableUseCase().execute('jp-1', 'ALL');
    const por = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(por.ok.kanbanColumn).toBe('COMPLETED');
    expect(por.nao.kanbanColumn).toBe('BLOQUEADO');
    expect(por.nulo.kanbanColumn).toBe('BLOQUEADO');
    expect(por.ausente.kanbanColumn).toBe('BLOQUEADO');
    expect(por.prog.kanbanColumn).toBe('IN_PROGRESS');
    expect(por.nao.funnelStage).toBe('QUALIFIED');
  });

  it('counts.columns: BLOQUEADO e COMPLETED separados, e a soma das colunas = total de linhas', async () => {
    mockFetchRawRows.mockResolvedValue([
      linha('1', 'QUALIFIED', true), linha('2', 'QUALIFIED', true), linha('3', 'QUALIFIED', false), linha('4', 'IN_PROGRESS', null),
    ]);
    const { counts } = await new GetFunnelTableUseCase().execute('jp-1', 'ALL');
    expect(counts.columns.COMPLETED).toBe(2);
    expect(counts.columns.BLOQUEADO).toBe(1);
    expect(Object.values(counts.columns).reduce((a, n) => a + n, 0)).toBe(4);
  });

  it('o filtro ?columns=BLOQUEADO devolve só os Completados não aptos', async () => {
    mockFetchRawRows.mockResolvedValue([linha('1', 'QUALIFIED', true), linha('2', 'QUALIFIED', false)]);
    const { rows } = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', null, ['BLOQUEADO']);
    expect(rows.map((r) => r.id)).toEqual(['2']);
  });
});

describe('FunnelTableRepository.fetchRawRows — projeta o apto do dono (spec 067, C2)', () => {
  it('a query chama fn_worker_is_apto só para etapas de Completado e devolve worker_apto', async () => {
    jest.resetModules();
    jest.doMock('@shared/database/DatabaseConnection', () => ({
      DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
    }));
    const { FunnelTableRepository: Real } = jest.requireActual('../../infrastructure/FunnelTableRepository');
    await new Real().fetchRawRows('jp-1');
    const sql = String(mockPoolQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('fn_worker_is_apto(wja.worker_id)');
    expect(sql).toContain("wja.application_funnel_stage IN ('COMPLETED', 'QUALIFIED', 'IN_DOUBT')");
    expect(sql).toContain('AS worker_apto');
  });
});
