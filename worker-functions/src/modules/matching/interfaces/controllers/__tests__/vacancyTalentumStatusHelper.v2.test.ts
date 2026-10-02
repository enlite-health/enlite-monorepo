/**
 * vacancyTalentumStatusHelper.v2.test.ts — spec 040 / F2 / T2.3
 *
 * O helper roda com o `TalentumApiClient` REAL; só o `fetch` é um stub em memória da v2.
 * Prova: o status compõe `GET /projects/:id` + `GET /projects/:id/prescreening`; o link é o WEB do
 * `publicId`; o áudio sai de `responseType`; projeto inexistente (404) → exists:false, não erro.
 */

jest.mock('@modules/integration', () => ({
  TalentumApiClient: jest.requireActual('../../../../integration/infrastructure/TalentumApiClient').TalentumApiClient,
}));

import { getVacancyTalentumStatus } from '../vacancyTalentumStatusHelper';
import { TalentumV2Stub } from '../../../../integration/infrastructure/__tests__/talentumV2Stub';

const originalFetch = global.fetch;
const envBackup = { ...process.env };

function makeDb(projectId: string | null): { query: jest.Mock } {
  return { query: jest.fn().mockResolvedValue({ rows: [{ talentum_project_id: projectId }] }) };
}

describe('getVacancyTalentumStatus com o cliente v2 real (stub de fetch)', () => {
  let stub: TalentumV2Stub;

  beforeEach(() => {
    stub = new TalentumV2Stub();
    global.fetch = stub.asFetch();
    process.env.TALENTUM_API_EMAIL = 'stub-user-e2e-only';
    process.env.TALENTUM_API_PASSWORD = 'stub-key-e2e-only';
    process.env.TALENTUM_API_BASE_URL = 'http://stub.invalid';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...envBackup };
  });

  it('projeto vivo: exists=true, link web do publicId e áudio derivado de responseType', async () => {
    const p = stub.seed({
      _id: 'proj-vivo',
      name: 'EN 1#1',
      questions: [
        { questionId: 'q1', question: 'a', responseType: ['text', 'audio'] },
        { questionId: 'q2', question: 'b', responseType: ['text', 'audio'] },
      ],
    });

    const result = await getVacancyTalentumStatus(makeDb('proj-vivo') as never, 'vac-1');

    expect(result).toEqual({
      kind: 'ok',
      published: true,
      exists: true,
      whatsappUrl: `https://www.v2.talentum.chat/public/pre-screening/${p.publicId}/chat`,
      audioEnabled: true,
    });
    // compõe 2 GETs da v2 (projeto + prescreening), depois do login
    expect(stub.calls.filter((c) => c.path.startsWith('/projects/proj-vivo')).map((c) => c.path)).toEqual([
      '/projects/proj-vivo',
      '/projects/proj-vivo/prescreening',
    ]);
  });

  it('pergunta só-texto na Talentum → audioEnabled=false', async () => {
    stub.seed({ _id: 'proj-txt', name: 'EN 2#1', questions: [{ questionId: 'q1', question: 'a', responseType: ['text'] }] });
    const result = await getVacancyTalentumStatus(makeDb('proj-txt') as never, 'vac-1');
    expect(result).toMatchObject({ kind: 'ok', exists: true, audioEnabled: false });
  });

  it('projectId gravado que não existe na v2 (404) → published=true, exists=false (não é erro)', async () => {
    const result = await getVacancyTalentumStatus(makeDb('id-antigo-morto') as never, 'vac-1');
    expect(result).toEqual({ kind: 'ok', published: true, exists: false });
  });

  it('prescreening inativo (400 na v2) → kind=error com o status na mensagem', async () => {
    stub.seed({ _id: 'proj-400', name: 'PHONE', type: 'PHONE_CALL', prescreening400: true });
    const result = await getVacancyTalentumStatus(makeDb('proj-400') as never, 'vac-1');
    expect(result.kind).toBe('error');
    expect((result as { message: string }).message).toContain('HTTP 400');
  });
});
