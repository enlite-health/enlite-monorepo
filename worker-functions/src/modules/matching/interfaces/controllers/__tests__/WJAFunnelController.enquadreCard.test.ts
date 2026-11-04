/**
 * Card do funil com os dois campos do evento de enquadre (spec 052, T-30c): `convocation` e `enquadreOrigin`.
 * A leitura vai na MESMA query do funil (colunas `convocation_starts_at` / `enquadre_origin_code`), sem query extra: os testes
 * existentes do controller, que enfileiram respostas por ordem, seguem intactos. Linha SEM as colunas = ambos `null`.
 */
const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockQuery }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: jest.fn().mockResolvedValue('Ficticio') })),
}));
jest.mock('../../../infrastructure/BlockedApplicationQueryRepository', () => ({
  ...jest.requireActual('../../../infrastructure/BlockedApplicationQueryRepository'),
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({ listByVacancy: jest.fn().mockResolvedValue([]) })),
}));
jest.mock('../../../infrastructure/BlockedApplicationRepository', () => ({
  BlockedApplicationRepository: jest.fn().mockImplementation(() => ({})),
}));

import type { Request, Response } from 'express';
import { WJAFunnelController } from '../WJAFunnelController';

function row(id: string, stage: string, over: Record<string, unknown> = {}) {
  return {
    id, worker_id: `wid-${id}-aaaa-bbbb-cccc-12345678`, first_name_encrypted: 'encrypted:a', last_name_encrypted: 'encrypted:b',
    worker_phone: null, occupation_raw: 'AT', interview_date: null, interview_time: null, meet_link: null,
    resultado: null, attended: null, rejection_reason_category: null, rejection_reason: null, redireccionamiento: null,
    match_score: null, acquisition_channel: null, funnel_stage: stage, source: 'manual', messaged_at: '2026-10-01T10:00:00Z',
    talentum_status: null, work_zone: null,
    worker_apto: true, // spec 067: Completado sem apto cairia em BLOQUEADO
    ...over,
  };
}

async function funnel(rows: Record<string, unknown>[]) {
  mockQuery.mockResolvedValueOnce({ rows });
  const req = { params: { id: 'vaga-1' }, body: {}, query: {} } as unknown as Request;
  const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
  await new WJAFunnelController().getEncuadreFunnel(req, res);
  const { stages } = (res.json as jest.Mock).mock.calls[0][0].data as { stages: Record<string, Array<Record<string, unknown>>> };
  return { stages, sql: mockQuery.mock.calls[0][0] as string };
}

beforeEach(() => mockQuery.mockReset());

describe('getEncuadreFunnel — convocation e enquadreOrigin (T-30c)', () => {
  it('(11a) convocado ativo: convocation com o início em ISO; sem origem', async () => {
    const { stages } = await funnel([row('c1', 'COMPLETED', { convocation_starts_at: new Date('2026-10-16T17:00:00.000Z') })]);
    expect(stages.COMPLETED[0].convocation).toEqual({ startsAt: '2026-10-16T17:00:00.000Z' });
    expect(stages.COMPLETED[0].enquadreOrigin).toBeNull();
  });

  it('(11b) selecionado com evento: enquadreOrigin com o código; sem convocação', async () => {
    const { stages } = await funnel([row('s1', 'SELECTED', { enquadre_origin_code: 'ENC-ABC123' })]);
    expect(stages.SELECTED[0].enquadreOrigin).toEqual({ eventCode: 'ENC-ABC123' });
    expect(stages.SELECTED[0].convocation).toBeNull();
  });

  it('(11c) sem evento: os dois campos são null (linha com colunas nulas e linha sem as colunas)', async () => {
    const { stages } = await funnel([
      row('n1', 'COMPLETED', { convocation_starts_at: null, enquadre_origin_code: null }),
      row('n2', 'QUICK_RESPONSE_TEAM'),
    ]);
    for (const card of [stages.COMPLETED[0], stages.QUICK_RESPONSE_TEAM[0]]) {
      expect(card.convocation).toBeNull();
      expect(card.enquadreOrigin).toBeNull();
    }
  });

  it('a query só considera participação ativa para a convocação e exclui evento cancelado da origem', async () => {
    const { sql } = await funnel([]);
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('ep.released_at IS NULL');
    expect(flat).toContain("ev.status <> 'cancelled'");
    expect(flat).toContain("ep.outcome IN ('selected', 'quick_response')");
    expect(flat).toContain("wja.application_funnel_stage IN ('SELECTED', 'QUICK_RESPONSE_TEAM')");
  });
});
