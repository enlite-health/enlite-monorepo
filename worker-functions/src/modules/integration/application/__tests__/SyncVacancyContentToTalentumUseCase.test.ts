/**
 * SyncVacancyContentToTalentumUseCase (D1/D4). O cliente Talentum é SEMPRE dublê: nenhuma chamada sai para a rede.
 */
import { SyncVacancyContentToTalentumUseCase } from '../SyncVacancyContentToTalentumUseCase';
import { OTHER_ACCOUNT_MESSAGE } from '../../domain/talentumErrors';

const ID = '11111111-1111-1111-1111-111111111111';

function qrow(question: string, desired = 'resp', weight = 5) {
  return { question, response_type: ['text'], desired_response: desired, weight, required: false, analyzed: true, early_stoppage: false };
}

function setup(opts: {
  vacancy?: Record<string, unknown> | null;
  local?: ReturnType<typeof qrow>[];
  remoteQuestions?: Array<Record<string, unknown>>;
  updateError?: Error;
  getError?: Error;
  factoryError?: Error;
}) {
  const db = {
    query: jest.fn(async (sql: string) => {
      if (/FROM job_postings/.test(sql)) return { rows: opts.vacancy === null ? [] : [opts.vacancy ?? { title: 'Caso 1', talentum_project_id: 'proj-1', talentum_description: 'DESC LOCAL' }] };
      if (/FROM job_posting_prescreening_questions/.test(sql)) return { rows: opts.local ?? [qrow('Pregunta A')] };
      throw new Error(`SQL inesperado: ${sql}`);
    }),
  };
  const client = {
    getPrescreening: jest.fn(async () => {
      if (opts.getError) throw opts.getError;
      return { projectId: 'proj-1', title: 'Caso 1 remoto', description: 'DESC REMOTA', questions: opts.remoteQuestions ?? [{ questionId: 'qa', question: 'pregunta a', desiredResponse: 'VELHA' }] };
    }),
    updatePrescreening: jest.fn(async () => { if (opts.updateError) throw opts.updateError; }),
  };
  const factory = jest.fn(async () => { if (opts.factoryError) throw opts.factoryError; return client as never; });
  return { uc: new SyncVacancyContentToTalentumUseCase(db as never, factory), client, factory, db };
}

describe('SyncVacancyContentToTalentumUseCase.propagate', () => {
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(); });
  afterEach(() => jest.restoreAllMocks());

  it('NOT_PUBLISHED (sem talentum_project_id): não cria nem chama o cliente', async () => {
    const { uc, client, factory } = setup({ vacancy: { title: 'x', talentum_project_id: null, talentum_description: null } });
    await expect(uc.propagate(ID)).resolves.toEqual({ status: 'NOT_PUBLISHED' });
    expect(factory).not.toHaveBeenCalled();
    expect(client.getPrescreening).not.toHaveBeenCalled();
    expect(client.updatePrescreening).not.toHaveBeenCalled();
  });

  it('vaga inexistente também é NOT_PUBLISHED, sem tocar no cliente', async () => {
    const { uc, factory } = setup({ vacancy: null });
    await expect(uc.propagate(ID)).resolves.toEqual({ status: 'NOT_PUBLISHED' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('envia as perguntas do BANCO (não as remotas), com o questionId remoto herdado, e a descrição local', async () => {
    const { uc, client } = setup({ local: [qrow('  PREGUNTA   A ', 'RESPUESTA NUEVA', 8), qrow('Pregunta nueva')] });
    await expect(uc.propagate(ID, { traceId: 't' })).resolves.toEqual({ status: 'OK' });
    expect(client.updatePrescreening).toHaveBeenCalledTimes(1);
    const [projectId, body] = (client.updatePrescreening.mock.calls[0] as unknown) as [string, any];
    expect(projectId).toBe('proj-1');
    expect(body.description).toBe('DESC LOCAL');
    expect(body.questions).toHaveLength(2);
    expect(body.questions[0]).toMatchObject({ questionId: 'qa', desiredResponse: 'RESPUESTA NUEVA', weight: 8 }); // do banco, não 'VELHA'
    expect(body.questions[1]).not.toHaveProperty('questionId');
  });

  it('sem talentum_description local usa a descrição remota (nunca manda vazio)', async () => {
    const { uc, client } = setup({ vacancy: { title: 'Caso 1', talentum_project_id: 'proj-1', talentum_description: null } });
    await uc.propagate(ID);
    expect((client.updatePrescreening.mock.calls[0] as any)[1].description).toBe('DESC REMOTA');
  });

  it('403 → OTHER_ACCOUNT com a mensagem compartilhada', async () => {
    const { uc } = setup({ updateError: new Error('[TalentumApiClient] PATCH /projects/p — HTTP 403: {"message":"You are not allowed to access this project"}') });
    await expect(uc.propagate(ID)).resolves.toEqual({ status: 'OTHER_ACCOUNT', message: OTHER_ACCOUNT_MESSAGE });
  });

  it('GET 404 → FAILED (projeto morto); outras falhas → FAILED com reason; nunca lança; log sem PII', async () => {
    const dead = setup({ getError: new Error('GET /projects/p — HTTP 404: nope') });
    const r1 = await dead.uc.propagate(ID);
    expect(r1.status).toBe('FAILED');
    expect(dead.client.updatePrescreening).not.toHaveBeenCalled();

    const boom = setup({ updateError: new Error('HTTP 500: dados do candidato fulano@x.com') });
    const r2 = await boom.uc.propagate(ID);
    expect(r2.status).toBe('FAILED');
    expect(r2.message).toContain('HTTP 500');
    expect(r2.message).not.toContain('fulano@x.com');
    const logged = (console.error as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).not.toContain('fulano@x.com');

    const noClient = setup({ factoryError: new Error('sem credencial') });
    await expect(noClient.uc.propagate(ID)).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('sem perguntas no banco: FAILED e NÃO envia (mandar [] apagaria as do projeto)', async () => {
    const { uc, client } = setup({ local: [] });
    await expect(uc.propagate(ID)).resolves.toMatchObject({ status: 'FAILED' });
    expect(client.updatePrescreening).not.toHaveBeenCalled();
  });
});
