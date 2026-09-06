/**
 * EnsureVacancyShortLinkUseCase.test.ts
 *
 * Scenarios:
 *   1. Returns existing link (alreadyExisted=true) when channel already in social_short_links
 *   2. Creates new link, persists it, returns alreadyExisted=false when channel not present
 *   3. Handles legacy string-format links when checking for existing
 *   4. Throws when vacancy not found
 *   5. Preserves existing links when adding a new one
 *   6. Calls shortLinkService with correct params (caseNumber, vacancyNumber, country)
 *      — NUNCA com dado de paciente: a URL vai para o Short.io e para rede social.
 */

import { EnsureVacancyShortLinkUseCase } from '../EnsureVacancyShortLinkUseCase';
import { ShortLinkService } from '../../infrastructure/shortlinks/ShortLinkService';

const mockQuery = jest.fn();
const mockBuildAndCreate = jest.fn();

const mockPool = { query: mockQuery } as unknown as import('pg').Pool;
const mockShortLinkService = {
  buildAndCreate: mockBuildAndCreate,
} as unknown as ShortLinkService;

import { TEXTO_CLINICO, esperaSemVazamentoClinico, esperaSqlSemDadoClinico } from '../../__tests__/guardaVazamentoClinico';

describe('EnsureVacancyShortLinkUseCase', () => {
  let useCase: EnsureVacancyShortLinkUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new EnsureVacancyShortLinkUseCase(mockPool, mockShortLinkService);
  });

  const VACANCY_ID = 'vac-uuid-001';

  // ⚠️ GUARDA DE CLASSE. Este use case é o caminho do `VacancyCrudController` e
  // dos 3 scripts de backfill. Na revisão final do PR #249 o defeito ORIGINAL
  // — `p.diagnosis` no `utm_content` — foi reintroduzido POR AQUI e a suíte
  // inteira passou: 4381/4381 verdes. A fixture do banco não carregava clínico,
  // então nada tinha o que detectar.
  describe('vazamento clínico — a fixture do banco CARREGA diagnóstico', () => {
    const LINHA_COM_CLINICO = {
      case_number: 42,
      vacancy_number: 7,
      country: 'AR',
      // colunas que o SELECT NÃO deve pedir; se alguém puser o JOIN de volta,
      // o valor está aqui esperando e as asserções abaixo reprovam
      diagnosis: TEXTO_CLINICO,
      pathologies: TEXTO_CLINICO,
      social_short_links: {},
    };

    beforeEach(() => {
      mockQuery.mockResolvedValue({ rows: [LINHA_COM_CLINICO] });
      mockBuildAndCreate.mockResolvedValue({ shortURL: 'https://srt.io/new', id: 'new-id' });
    });

    it('nenhuma query pede diagnosis nem faz JOIN em patients — em NENHUMA delas', async () => {
      await useCase.execute(VACANCY_ID, 'site');

      esperaSqlSemDadoClinico(mockQuery.mock.calls);
    });

    it('nada de clínico atravessa para o ShortLinkService, em campo nenhum', async () => {
      const result = await useCase.execute(VACANCY_ID, 'site');

      esperaSemVazamentoClinico(mockBuildAndCreate.mock.calls, result);
    });

    it('o UPDATE gravado também não carrega clínico', async () => {
      await useCase.execute(VACANCY_ID, 'site');

      esperaSemVazamentoClinico(mockQuery.mock.calls);
    });
  });

  it('returns existing link with alreadyExisted=true when channel is already stored', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        case_number: 42,
        vacancy_number: 7,
        country: 'AR',
        social_short_links: {
          site: { url: 'https://srt.io/existing', id: 'existing-id' },
        },
      }],
    });

    const result = await useCase.execute(VACANCY_ID, 'site');

    expect(result).toEqual({ shortURL: 'https://srt.io/existing', alreadyExisted: true });
    expect(mockBuildAndCreate).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns existing legacy string link with alreadyExisted=true', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        case_number: 10,
        vacancy_number: 1,
        country: null,
        social_short_links: { facebook: 'https://srt.io/fb-legacy' },
      }],
    });

    const result = await useCase.execute(VACANCY_ID, 'facebook');

    expect(result).toEqual({ shortURL: 'https://srt.io/fb-legacy', alreadyExisted: true });
    expect(mockBuildAndCreate).not.toHaveBeenCalled();
  });

  it('creates new link, updates DB, and returns alreadyExisted=false', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          case_number: 42,
          vacancy_number: 7,
          country: 'AR',
          social_short_links: {},
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

    mockBuildAndCreate.mockResolvedValueOnce({
      shortURL: 'https://srt.io/new',
      id: 'new-id',
      originalURL: 'https://app.enlite.health/vacantes/caso42-7?utm_source=portal_jobs',
    });

    const result = await useCase.execute(VACANCY_ID, 'site');

    expect(result).toEqual({ shortURL: 'https://srt.io/new', alreadyExisted: false });
    expect(mockBuildAndCreate).toHaveBeenCalledWith({
      caseNumber: 42,
      vacancyNumber: 7,
      channel: 'site',
      country: 'AR',
    });

    // Verify UPDATE was called
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = mockQuery.mock.calls[1];
    expect(updateSql).toContain('UPDATE job_postings');
    expect(updateParams[1]).toBe(VACANCY_ID);

    // Verify social_short_links JSON contains the new link
    const updatedLinks = JSON.parse(updateParams[0] as string);
    expect(updatedLinks.site).toEqual({ url: 'https://srt.io/new', id: 'new-id' });
  });

  it('throws when vacancy not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(useCase.execute(VACANCY_ID, 'site')).rejects.toThrow(
      `Vacancy ${VACANCY_ID} not found`,
    );
  });

  it('preserves existing links when adding a new channel', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          case_number: 5,
          vacancy_number: 2,
          country: null,
          social_short_links: {
            facebook: { url: 'https://srt.io/fb', id: 'fb-id' },
          },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    mockBuildAndCreate.mockResolvedValueOnce({
      shortURL: 'https://srt.io/inst',
      id: 'inst-id',
      originalURL: 'https://app.enlite.health/vacantes/caso5-2?utm_source=instagram',
    });

    await useCase.execute(VACANCY_ID, 'instagram');

    const [, updateParams] = mockQuery.mock.calls[1];
    const updatedLinks = JSON.parse(updateParams[0] as string);
    expect(updatedLinks.facebook).toEqual({ url: 'https://srt.io/fb', id: 'fb-id' });
    expect(updatedLinks.instagram).toEqual({ url: 'https://srt.io/inst', id: 'inst-id' });
  });

  it('defaults channel to site when not provided', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          case_number: 1,
          vacancy_number: 1,
          country: null,
          social_short_links: {},
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    mockBuildAndCreate.mockResolvedValueOnce({
      shortURL: 'https://srt.io/default',
      id: 'def-id',
      originalURL: 'https://app.enlite.health/vacantes/caso1-1?utm_source=portal_jobs',
    });

    await useCase.execute(VACANCY_ID);

    expect(mockBuildAndCreate).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'site' }),
    );
  });
});
