/** deleteVacancyTalentumProject — cliente Talentum SEMPRE dublê: nenhuma chamada sai para a rede. */
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: (...a: unknown[]) => mockReportError(...a) }));

import { deleteVacancyTalentumProject } from '../deleteVacancyTalentumProject';

const input = { vacancyId: 'jp-1', projectId: 'proj-1' };

describe('deleteVacancyTalentumProject', () => {
  beforeEach(() => mockReportError.mockClear());

  it('chama o DELETE com o project id e devolve OK', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    await expect(deleteVacancyTalentumProject(input, async () => ({ deletePrescreening: del }))).resolves.toEqual({ status: 'OK' });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('proj-1');
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('404 (já não existe) = sucesso, sem reportar', async () => {
    const del = jest.fn().mockRejectedValue(new Error('[TalentumApiClient] DELETE /projects/proj-1 — HTTP 404: not found'));
    await expect(deleteVacancyTalentumProject(input, async () => ({ deletePrescreening: del }))).resolves.toEqual({ status: 'OK' });
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('falha (500) NÃO é silenciosa: FAILED com mensagem + reportError', async () => {
    const del = jest.fn().mockRejectedValue(new Error('[TalentumApiClient] DELETE /projects/proj-1 — HTTP 500: boom'));
    const r = await deleteVacancyTalentumProject(input, async () => ({ deletePrescreening: del }));
    expect(r.status).toBe('FAILED');
    expect(r.message).toMatch(/borralo a mano/);
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ vacancyId: 'jp-1' }));
  });

  it('403 (projeto de outra conta) → OTHER_ACCOUNT + reportError', async () => {
    const del = jest.fn().mockRejectedValue(new Error('[TalentumApiClient] DELETE /projects/proj-1 — HTTP 403: nope'));
    const r = await deleteVacancyTalentumProject(input, async () => ({ deletePrescreening: del }));
    expect(r.status).toBe('OTHER_ACCOUNT');
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('cliente que não autentica (factory rejeita) → FAILED + reportError, nunca lança', async () => {
    const r = await deleteVacancyTalentumProject(input, async () => { throw new Error('auth down'); });
    expect(r.status).toBe('FAILED');
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });
});
