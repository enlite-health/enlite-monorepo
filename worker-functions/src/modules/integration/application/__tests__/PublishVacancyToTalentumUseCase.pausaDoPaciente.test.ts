/**
 * PublishVacancyToTalentumUseCase.pausaDoPaciente.test.ts — semaforo-da-vaga F4 (I1): a vaga lançada com o paciente JÁ pausado nasce
 * PENDING_PAUSE na MESMA transação do publish (pela porta, reusando o marcador do escritor de estado) e o envio da pausa roda
 * DEPOIS do commit. Sem a porta, nada muda (os outros testes do publish constroem o use case sem ela).
 */

// ── Mocks (antes dos imports) ────────────────────────────────────

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
        connect: mockConnect,
      }),
    }),
  },
}));

const mockCreatePrescreening = jest.fn();
const mockGetPrescreening = jest.fn();
const mockDeletePrescreening = jest.fn();
const mockTalentumCreate = jest.fn();
jest.mock('../../infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: {
    create: (...args: unknown[]) => mockTalentumCreate(...args),
  },
}));

// ── Imports ──────────────────────────────────────────────────────

import { PublishVacancyToTalentumUseCase } from '../PublishVacancyToTalentumUseCase';

// ── Helpers ──────────────────────────────────────────────────────

const JP_ID = '22222222-2222-2222-2222-222222222222';

function rowsFor(overrides: Record<string, unknown> = {}) {
  return {
    id: JP_ID,
    title: 'Caso 42',
    talentum_project_id: null,
    talentum_description: 'descrição já existente',
    is_draft: true,
    ...overrides,
  };
}

describe('PublishVacancyToTalentumUseCase — paciente pausado (I1)', () => {
  const QUESTION = { id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false };
  const clientSqls = () => mockClientQuery.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockTalentumCreate.mockResolvedValue({ createPrescreening: mockCreatePrescreening, getPrescreening: mockGetPrescreening, deletePrescreening: mockDeletePrescreening });
    mockCreatePrescreening.mockResolvedValue({ projectId: 'proj-1', publicId: 'pub-1' });
    mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'https://wa.me/talentum/proj-1', slug: 'caso-42' });
    mockQuery.mockResolvedValueOnce({ rows: [rowsFor()] }).mockResolvedValueOnce({ rows: [QUESTION] });
  });

  it('marca na transação (entre o UPDATE e o COMMIT) e entrega os ids marcados à porta DEPOIS do commit', async () => {
    const ordem: string[] = [];
    mockClientQuery.mockImplementation(async (sql: string) => { ordem.push(String(sql).slice(0, 14)); return { rows: [] }; });
    const port = {
      markPauseInTx: jest.fn(async () => { ordem.push('MARCA'); return [JP_ID]; }),
      onPublished: jest.fn(async () => { ordem.push('POS_COMMIT'); }),
    };

    await new PublishVacancyToTalentumUseCase(port).publish({ jobPostingId: JP_ID });

    expect(port.markPauseInTx).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(Function) }), JP_ID);
    expect(port.onPublished).toHaveBeenCalledWith(JP_ID, [JP_ID]);
    expect(ordem.indexOf('UPDATE job_post')).toBeLessThan(ordem.indexOf('MARCA'));
    expect(ordem.indexOf('MARCA')).toBeLessThan(ordem.indexOf('COMMIT'));
    expect(ordem.indexOf('COMMIT')).toBeLessThan(ordem.indexOf('POS_COMMIT'));
  });

  it('paciente vivo (a porta não marca nada): onPublished recebe lista vazia', async () => {
    const port = { markPauseInTx: jest.fn(async () => []), onPublished: jest.fn(async () => undefined) };
    await new PublishVacancyToTalentumUseCase(port).publish({ jobPostingId: JP_ID });
    expect(port.onPublished).toHaveBeenCalledWith(JP_ID, []);
  });

  it('a marcação que falha NÃO desfaz o publish (o projeto já existe no Talentum): SAVEPOINT, o COMMIT acontece e o pós-commit roda sem ids', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    const port = { markPauseInTx: jest.fn(async () => { throw new Error('marca-boom'); }), onPublished: jest.fn(async () => undefined) };

    const out = await new PublishVacancyToTalentumUseCase(port).publish({ jobPostingId: JP_ID });

    expect(out.projectId).toBe('proj-1');
    expect(clientSqls()).toContain('COMMIT');
    expect(clientSqls()).not.toContain('ROLLBACK');
    expect(clientSqls().some((s) => s.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(port.onPublished).toHaveBeenCalledWith(JP_ID, []);
  });
});
