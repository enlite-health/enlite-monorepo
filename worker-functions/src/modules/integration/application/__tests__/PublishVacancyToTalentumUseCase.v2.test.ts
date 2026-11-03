/**
 * PublishVacancyToTalentumUseCase.v2.test.ts — spec 040 / F2 / T2.1
 *
 * O use case roda com o `TalentumApiClient` REAL (nada de mock do cliente); só o `fetch` é trocado por
 * um stub em memória da v2 (`infrastructure/__tests__/talentumV2Stub.ts`, com as regras medidas na v2 real).
 * Prova: (1) o que vai para `job_postings.talentum_whatsapp_url` é o LINK WEB derivado do `publicId`
 * — nunca `wa.me`; (2) a FAQ do banco não é lida nem enviada; (3) o projeto fica IN_PROGRESS (o
 * `create` já ativa); (4) título > 50 caracteres não derruba o publish (a v2 devolve 400 acima disso).
 */

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery, connect: mockConnect }),
    }),
  },
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { PublishVacancyToTalentumUseCase } from '../PublishVacancyToTalentumUseCase';
import { JobPostingAuditRepository } from '../../../matching/infrastructure/JobPostingAuditRepository';
import { TalentumV2Stub } from '../../infrastructure/__tests__/talentumV2Stub';

const JP_ID = '33333333-3333-3333-3333-333333333333';
const originalFetch = global.fetch;
const envBackup = { ...process.env };

function setupQueries(title: string) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM job_postings')) {
      return { rows: [{ id: JP_ID, title, talentum_project_id: null, talentum_description: 'descripción', is_draft: true }] };
    }
    if (sql.includes('job_posting_prescreening_questions')) {
      return {
        rows: [{ id: 'q1', question: '¿Experiencia?', response_type: ['text', 'audio'], desired_response: 'sí', weight: 5, required: true, analyzed: true, early_stoppage: false }],
      };
    }
    return { rows: [] };
  });
}

describe('PublishVacancyToTalentumUseCase com o cliente v2 real (stub de fetch)', () => {
  let stub: TalentumV2Stub;
  let updateParams: unknown[] | undefined;
  let updateSql = '';

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    updateParams = undefined;
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('UPDATE job_postings')) updateParams = params;
      return { rows: [] };
    });
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: jest.fn() });
    stub = new TalentumV2Stub();
    global.fetch = stub.asFetch();
    process.env.TALENTUM_API_EMAIL = 'stub-user-e2e-only';
    process.env.TALENTUM_API_PASSWORD = 'stub-key-e2e-only';
    process.env.TALENTUM_API_BASE_URL = 'http://stub.invalid';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    process.env = { ...envBackup };
  });

  it('grava o link WEB do publicId em talentum_whatsapp_url (nunca wa.me) e deixa o projeto IN_PROGRESS', async () => {
    setupQueries('EN 123#4');
    const useCase = new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({}));

    const result = await useCase.publish({ jobPostingId: JP_ID });

    const proj = [...stub.projects.values()][0];
    const expected = `https://www.v2.talentum.chat/public/pre-screening/${proj.publicId}/chat`;
    expect(result).toEqual({ projectId: proj._id, publicId: proj.publicId, whatsappUrl: expected });
    // UPDATE job_postings SET project_id=$1, public_id=$2, whatsapp_url=$3, slug=$4 ... WHERE id=$5
    expect(updateParams).toEqual([proj._id, proj.publicId, expected, proj.slug, JP_ID, proj.prescreeningId]);
    expect(proj.prescreeningId).not.toBe(proj._id);
    expect(String(updateParams![2])).not.toContain('wa.me');
    expect(proj.status).toBe('IN_PROGRESS');
    expect(proj.description).toBe('descripción');
  });

  it('API sem _id do prescreening: o publish NÃO cai, grava talentum_prescreening_id NULL e loga o id da vaga', async () => {
    setupQueries('EN 123#4');
    stub.omitPrescreeningId = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const useCase = new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({}));

    const result = await useCase.publish({ jobPostingId: JP_ID });

    expect(result.projectId).toBeTruthy();
    expect(updateParams![5]).toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toContain(JP_ID);
  });

  it('_id do prescreening já em OUTRA vaga viva: o UPDATE leva o guarda (sem depender de 23505), grava NULL e loga talentum_prescreening_id_colide com os 2 ids', async () => {
    setupQueries('EN 123#4');
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('UPDATE job_postings')) {
        updateParams = params;
        updateSql = String(sql);
        return { rows: [{ talentum_prescreening_id: null }] };
      }
      if (String(sql).includes('FROM job_postings WHERE talentum_prescreening_id')) return { rows: [{ id: 'jp-dona' }] };
      return { rows: [] };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({})).publish({ jobPostingId: JP_ID });

    expect(result.projectId).toBeTruthy();
    // colide → mantém o valor anterior da vaga (COALESCE), igual ao sync; nunca sobrescreve com NULL
    expect(updateSql).toMatch(/talentum_prescreening_id = COALESCE\(CASE WHEN EXISTS/);
    expect(updateSql).toMatch(/EXISTS \(SELECT 1 FROM job_postings o WHERE o\.talentum_prescreening_id = \$6::text/);
    expect(warn.mock.calls.flat().join(' ')).toContain(`talentum_prescreening_id_colide vaga=${JP_ID} outra_vaga=jp-dona`);
  });

  it('a FAQ do banco não é lida nem enviada à Talentum', async () => {
    setupQueries('EN 123#4');
    const useCase = new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({}));

    await useCase.publish({ jobPostingId: JP_ID });

    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes('job_posting_prescreening_faq'))).toBe(false);
  });

  it('título > 50 caracteres: o publish funciona (nome cortado em 50), não vira 502', async () => {
    const longTitle = 'EN 123#4 - Acompañante terapéutico para paciente con TEA nivel 2 en Recoleta';
    setupQueries(longTitle);
    const useCase = new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({}));

    const result = await useCase.publish({ jobPostingId: JP_ID });

    const proj = [...stub.projects.values()][0];
    expect(result.projectId).toBe(proj._id);
    expect(proj.name.length).toBeLessThanOrEqual(50);
    expect(proj.name).toBe(longTitle.slice(0, 50).trimEnd());
  });

  describe('auditoria (actor) e gancho pós-commit', () => {
    const ACTOR = { actorUserId: 'u1', actorType: 'HUMAN' as const, actorLabel: 'admin_panel', traceId: 't1' };

    it('publicar e despublicar COM actor gravam DRAFT_CHANGED (false e true), com e sem traceId', async () => {
      const audit = jest.spyOn(JobPostingAuditRepository.prototype, 'logEventSafe').mockResolvedValue(undefined);
      setupQueries('EN 123#4');
      const useCase = new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({}));

      await useCase.publish({ jobPostingId: JP_ID }, ACTOR);
      const projectId = [...stub.projects.keys()][0];
      mockQuery.mockImplementation(async () => ({ rows: [{ talentum_project_id: projectId, is_draft: false }] }));
      await useCase.unpublish({ jobPostingId: JP_ID }, { ...ACTOR, traceId: undefined });

      expect(audit).toHaveBeenCalledTimes(2);
      expect(audit.mock.calls[0][1]).toMatchObject({ jobPostingId: JP_ID, changes: { before: true, after: false }, traceId: 't1' });
      expect(audit.mock.calls[1][1]).toMatchObject({ changes: { before: false, after: true }, traceId: null });
      expect(stub.projects.size).toBe(0); // despublicar apagou o projeto na v2
    });

    it('publicar com actor sem traceId grava traceId null', async () => {
      const audit = jest.spyOn(JobPostingAuditRepository.prototype, 'logEventSafe').mockResolvedValue(undefined);
      setupQueries('EN 123#4');

      await new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({})).publish({ jobPostingId: JP_ID }, { ...ACTOR, traceId: undefined });

      expect(audit.mock.calls[0][1]).toMatchObject({ traceId: null });
    });

    it('gancho que rejeita com valor que não é Error: o publish AINDA resolve (2ª trava)', async () => {
      setupQueries('EN 123#4');
      const result = await new PublishVacancyToTalentumUseCase(jest.fn().mockRejectedValue('texto cru')).publish({ jobPostingId: JP_ID });

      expect(result.projectId).toBe([...stub.projects.keys()][0]);
    });
  });
});
