/**
 * vacancyTalentumStatusHelper.test.ts
 *
 * Cenários:
 *  1. Vaga não encontrada → { kind: 'not_found' }
 *  2. talentum_project_id NULL → { kind: 'ok', published: false, exists: false }
 *  3. projectId presente + GET ok → { kind: 'ok', published: true, exists: true, whatsappUrl }
 *  4. projectId presente + GET 404 (Talentum) → { kind: 'ok', published: true, exists: false } (não é erro)
 *  5. projectId presente + erro não-404 → { kind: 'error', message }
 */

const mockGetPrescreening = jest.fn();
const mockCreate = jest.fn().mockResolvedValue({ getPrescreening: mockGetPrescreening });

jest.mock('@modules/integration', () => ({
  TalentumApiClient: { create: (...args: unknown[]) => mockCreate(...args) },
}));

import { getVacancyTalentumStatus } from '../vacancyTalentumStatusHelper';

function makeDb(rows: object[]): { query: jest.Mock } {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('getVacancyTalentumStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ getPrescreening: mockGetPrescreening });
  });

  it('vaga não encontrada → kind=not_found', async () => {
    const db = makeDb([]);
    const result = await getVacancyTalentumStatus(db as never, 'vac-missing');
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('talentum_project_id NULL → published=false, exists=false', async () => {
    const db = makeDb([{ talentum_project_id: null }]);
    const result = await getVacancyTalentumStatus(db as never, 'vac-1');
    expect(result).toEqual({ kind: 'ok', published: false, exists: false });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('GET ok sem perguntas → audioEnabled=false (nada a avaliar)', async () => {
    const db = makeDb([{ talentum_project_id: 'proj-1' }]);
    mockGetPrescreening.mockResolvedValueOnce({
      projectId: 'proj-1',
      whatsappUrl: 'https://wa.me/xyz',
    });
    const result = await getVacancyTalentumStatus(db as never, 'vac-1');
    expect(result).toEqual({
      kind: 'ok',
      published: true,
      exists: true,
      whatsappUrl: 'https://wa.me/xyz',
      audioEnabled: false,
    });
    expect(mockGetPrescreening).toHaveBeenCalledWith('proj-1');
  });

  it('todas as perguntas aceitam áudio → audioEnabled=true (ticket 86ajfm80t)', async () => {
    const db = makeDb([{ talentum_project_id: 'proj-1' }]);
    mockGetPrescreening.mockResolvedValueOnce({
      projectId: 'proj-1',
      whatsappUrl: 'https://wa.me/xyz',
      questions: [
        { responseType: ['text', 'audio'] },
        { responseType: ['audio', 'text'] },
      ],
    });
    const result = await getVacancyTalentumStatus(db as never, 'vac-1');
    expect(result).toMatchObject({ kind: 'ok', published: true, exists: true, audioEnabled: true });
  });

  it('alguma pergunta só-texto → audioEnabled=false (regressão do bug do ticket)', async () => {
    const db = makeDb([{ talentum_project_id: 'proj-1' }]);
    mockGetPrescreening.mockResolvedValueOnce({
      projectId: 'proj-1',
      whatsappUrl: 'https://wa.me/xyz',
      questions: [
        { responseType: ['text', 'audio'] },
        { responseType: ['text'] }, // artefato da IA — áudio desativado
      ],
    });
    const result = await getVacancyTalentumStatus(db as never, 'vac-1');
    expect(result).toMatchObject({ kind: 'ok', audioEnabled: false });
  });

  it('projectId presente + GET 404 do Talentum → published=true, exists=false (não é erro)', async () => {
    const db = makeDb([{ talentum_project_id: 'proj-deleted' }]);
    mockGetPrescreening.mockRejectedValueOnce(
      new Error('[TalentumApiClient] GET /pre-screening/projects/proj-deleted — HTTP 404: Not Found'),
    );
    const result = await getVacancyTalentumStatus(db as never, 'vac-1');
    expect(result).toEqual({ kind: 'ok', published: true, exists: false });
  });

  it('erro não-404 do Talentum → kind=error com a mensagem', async () => {
    const db = makeDb([{ talentum_project_id: 'proj-1' }]);
    mockGetPrescreening.mockRejectedValueOnce(
      new Error('[TalentumApiClient] GET /pre-screening/projects/proj-1 — HTTP 500: Internal Server Error'),
    );
    const result = await getVacancyTalentumStatus(db as never, 'vac-1');
    expect(result.kind).toBe('error');
    expect((result as { message: string }).message).toContain('HTTP 500');
  });
});
