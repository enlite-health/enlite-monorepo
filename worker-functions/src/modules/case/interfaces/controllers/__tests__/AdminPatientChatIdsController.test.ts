import type { Request, Response } from 'express';
import { AdminPatientChatIdsController } from '../AdminPatientChatIdsController';
import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
  ChatIdOwnedBySamePatientRoleError,
  UnknownChatRoleError,
} from '../../../application/PatientChatIdsService';
import { FindPatientChatCandidatesUseCase } from '../../../application/FindPatientChatCandidatesUseCase';
import { GetPatientChatMapUseCase } from '../../../application/GetPatientChatMapUseCase';
import { ListChatGroupsUseCase } from '../../../application/ListChatGroupsUseCase';

jest.mock('@shared/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));
jest.mock('../../../application/PatientChatIdsService', () => {
  const actual = jest.requireActual('../../../application/PatientChatIdsService');
  return { ...actual, PatientChatIdsService: jest.fn().mockImplementation(() => ({})) };
});
jest.mock('../../../application/FindPatientChatCandidatesUseCase', () => {
  const actual = jest.requireActual('../../../application/FindPatientChatCandidatesUseCase');
  return { ...actual, FindPatientChatCandidatesUseCase: jest.fn().mockImplementation(() => ({})) };
});
jest.mock('../../../application/GetPatientChatMapUseCase', () => {
  const actual = jest.requireActual('../../../application/GetPatientChatMapUseCase');
  return { ...actual, GetPatientChatMapUseCase: jest.fn().mockImplementation(() => ({})) };
});
jest.mock('../../../application/ListChatGroupsUseCase', () => {
  const actual = jest.requireActual('../../../application/ListChatGroupsUseCase');
  return { ...actual, ListChatGroupsUseCase: jest.fn().mockImplementation(() => ({})) };
});

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const GROUP_A = '120363001111111111@g.us';
const GROUP_B = '120363002222222222@g.us';

function res() {
  const r = {} as Response & { status: jest.Mock; json: jest.Mock };
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

function req(over: Partial<Request> = {}): Request {
  return { params: { id: PATIENT }, query: {}, body: {}, ...over } as Request;
}

function build(over: {
  update?: jest.Mock;
  execute?: jest.Mock;
  mapExecute?: jest.Mock;
  groupsExecute?: jest.Mock;
} = {}) {
  const service = { update: over.update ?? jest.fn() } as unknown as PatientChatIdsService;
  const finder = { execute: over.execute ?? jest.fn() } as unknown as FindPatientChatCandidatesUseCase;
  const chatMap = {
    execute: over.mapExecute ?? jest.fn().mockResolvedValue({
      patients: [], total: 0, limit: 500, offset: 0, hasMore: false,
    }),
  } as unknown as GetPatientChatMapUseCase;
  const listGroups = {
    execute: over.groupsExecute ?? jest.fn().mockResolvedValue({
      ok: true, groups: [], total: 0, limit: 50, offset: 0, hasMore: false, listTruncated: false,
    }),
  } as unknown as ListChatGroupsUseCase;
  return {
    controller: new AdminPatientChatIdsController(service, finder, chatMap, listGroups),
    service, finder, chatMap, listGroups,
  };
}

describe('AdminPatientChatIdsController', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, PATIENT_CHAT_LOOKUP_ENABLED: 'true' };
  });
  afterAll(() => { process.env = OLD_ENV; });

  describe('GET chat-candidates', () => {
    it('200 com candidatos', async () => {
      const execute = jest.fn().mockResolvedValue({
        ok: true,
        candidates: [{ chatId: GROUP_A, chatName: 'Flia', memberCount: 3, score: 1, matchedTerms: ['perez'], linkedToOtherPatient: false }],
        totalGroups: 774,
      });
      const { controller } = build({ execute });
      const r = res();

      await controller.getChatCandidates(req(), r);

      expect(execute).toHaveBeenCalledWith(PATIENT, 10);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('passa o limit da query', async () => {
      const execute = jest.fn().mockResolvedValue({ ok: true, candidates: [], totalGroups: 0 });
      const { controller } = build({ execute });
      await controller.getChatCandidates(req({ query: { limit: '3' } as never }), res());
      expect(execute).toHaveBeenCalledWith(PATIENT, 3);
    });

    it('503 FEATURE_DISABLED quando o kill-switch está OFF (default)', async () => {
      delete process.env.PATIENT_CHAT_LOOKUP_ENABLED;
      const execute = jest.fn();
      const { controller } = build({ execute });
      const r = res();

      await controller.getChatCandidates(req(), r);

      expect(r.status).toHaveBeenCalledWith(503);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
      expect(execute).not.toHaveBeenCalled();
    });

    it('qualquer valor != "true" mantém a flag desligada', async () => {
      process.env.PATIENT_CHAT_LOOKUP_ENABLED = 'TRUE';
      const { controller } = build({ execute: jest.fn() });
      const r = res();
      await controller.getChatCandidates(req(), r);
      expect(r.status).toHaveBeenCalledWith(503);
    });

    it('400 para id fora de UUID', async () => {
      const { controller } = build();
      const r = res();
      await controller.getChatCandidates(req({ params: { id: 'nope' } as never }), r);
      expect(r.status).toHaveBeenCalledWith(400);
    });

    it('400 para limit inválido', async () => {
      const { controller } = build();
      const r = res();
      await controller.getChatCandidates(req({ query: { limit: '999' } as never }), r);
      expect(r.status).toHaveBeenCalledWith(400);
    });

    it('502 quando o Periskope não respondeu', async () => {
      const { controller } = build({
        execute: jest.fn().mockResolvedValue({ ok: false, reason: 'periskope_unavailable' }),
      });
      const r = res();
      await controller.getChatCandidates(req(), r);
      expect(r.status).toHaveBeenCalledWith(502);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PERISKOPE_UNAVAILABLE' }));
    });

    it('422 quando o paciente não tem nome', async () => {
      const { controller } = build({
        execute: jest.fn().mockResolvedValue({ ok: false, reason: 'patient_has_no_name' }),
      });
      const r = res();
      await controller.getChatCandidates(req(), r);
      expect(r.status).toHaveBeenCalledWith(422);
    });

    it('404 quando o paciente não existe', async () => {
      const { controller } = build({
        execute: jest.fn().mockRejectedValue(new PatientChatIdsNotFoundError(PATIENT)),
      });
      const r = res();
      await controller.getChatCandidates(req(), r);
      expect(r.status).toHaveBeenCalledWith(404);
    });

    it('500 em erro inesperado', async () => {
      const { controller } = build({ execute: jest.fn().mockRejectedValue(new Error('boom')) });
      const r = res();
      await controller.getChatCandidates(req(), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });

    it('500 também para rejeição não-Error', async () => {
      const { controller } = build({ execute: jest.fn().mockRejectedValue('texto') });
      const r = res();
      await controller.getChatCandidates(req(), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });
  });

  describe('PUT chat-ids', () => {
    const body = { chatIds: { FAMILY: GROUP_A, PROVIDERS: GROUP_B } };
    const saved = { FAMILY: GROUP_A, PROVIDERS: GROUP_B };

    it('200 com o mapa gravado + os aliases legados derivados', async () => {
      const update = jest.fn().mockResolvedValue(saved);
      const { controller } = build({ update });
      const r = res();

      await controller.updateChatIds(req({ body }), r);

      expect(update).toHaveBeenCalledWith(PATIENT, saved);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith({
        success: true,
        data: {
          id: PATIENT,
          chatIds: saved,
          familyChatId: GROUP_A,
          providersChatId: GROUP_B,
        },
      });
    });

    it('aceita o body LEGADO { familyChatId, providersChatId } e traduz para papéis', async () => {
      const update = jest.fn().mockResolvedValue(saved);
      const { controller } = build({ update });
      const r = res();

      await controller.updateChatIds(
        req({ body: { familyChatId: GROUP_A, providersChatId: GROUP_B } }),
        r,
      );

      expect(update).toHaveBeenCalledWith(PATIENT, { FAMILY: GROUP_A, PROVIDERS: GROUP_B });
      expect(r.status).toHaveBeenCalledWith(200);
    });

    it('papel NOVO do catálogo já atravessa sem mudança de rota', async () => {
      const update = jest.fn().mockResolvedValue({ HEALTH_PLAN: GROUP_A });
      const { controller } = build({ update });
      const r = res();

      await controller.updateChatIds(req({ body: { chatIds: { HEALTH_PLAN: GROUP_A } } }), r);

      expect(update).toHaveBeenCalledWith(PATIENT, { HEALTH_PLAN: GROUP_A });
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith({
        success: true,
        data: {
          id: PATIENT,
          chatIds: { HEALTH_PLAN: GROUP_A },
          familyChatId: null,
          providersChatId: null,
        },
      });
    });

    it('400 UNKNOWN_CHAT_ROLE quando o serviço recusa o papel, com a lista', async () => {
      // O papel fora do catálogo não é mais barrado pelo schema (o catálogo é
      // dado, não código): o serviço o recusa depois de ler o banco, e o
      // controller precisa traduzir isso em 400 com código próprio — senão a
      // tela mostraria "erro interno" para um caso que tem conserto claro.
      const update = jest.fn().mockRejectedValue(new UnknownChatRoleError(['NEIGHBOURS']));
      const { controller } = build({ update });
      const r = res();

      await controller.updateChatIds(req({ body: { chatIds: { NEIGHBOURS: GROUP_A } } }), r);

      expect(r.status).toHaveBeenCalledWith(400);
      expect(r.json).toHaveBeenCalledWith({
        success: false,
        error: 'Unknown or inactive chat role',
        code: 'UNKNOWN_CHAT_ROLE',
        details: { roles: ['NEIGHBOURS'] },
      });
    });

    it('400 para chave de papel FORA DA FORMA — este o schema ainda barra', async () => {
      const update = jest.fn();
      const { controller } = build({ update });
      const r = res();
      await controller.updateChatIds(req({ body: { chatIds: { 'health plan': GROUP_A } } }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(update).not.toHaveBeenCalled();
    });

    it('400 para o MESMO grupo em dois papéis do mesmo paciente', async () => {
      const update = jest.fn();
      const { controller } = build({ update });
      const r = res();
      await controller.updateChatIds(
        req({ body: { chatIds: { FAMILY: GROUP_A, HEALTH_PLAN: GROUP_A } } }),
        r,
      );
      expect(r.status).toHaveBeenCalledWith(400);
      expect(update).not.toHaveBeenCalled();
    });

    it('não exige a flag de lookup — gravar é caminho interno', async () => {
      delete process.env.PATIENT_CHAT_LOOKUP_ENABLED;
      const update = jest.fn().mockResolvedValue(saved);
      const { controller } = build({ update });
      const r = res();
      await controller.updateChatIds(req({ body }), r);
      expect(r.status).toHaveBeenCalledWith(200);
    });

    it('400 para id fora de UUID', async () => {
      const { controller } = build();
      const r = res();
      await controller.updateChatIds(req({ params: { id: 'x' } as never, body }), r);
      expect(r.status).toHaveBeenCalledWith(400);
    });

    it('400 para chat 1-1 no body', async () => {
      const update = jest.fn();
      const { controller } = build({ update });
      const r = res();
      await controller.updateChatIds(req({ body: { chatIds: { FAMILY: '549116@c.us' } } }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(update).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const { controller } = build({
        update: jest.fn().mockRejectedValue(new PatientChatIdsNotFoundError(PATIENT)),
      });
      const r = res();
      await controller.updateChatIds(req({ body }), r);
      expect(r.status).toHaveBeenCalledWith(404);
    });

    it('409 CHAT_ID_ALREADY_LINKED com a lista de conflitos', async () => {
      const conflicts = [{ chatId: GROUP_A, patientId: 'outro', role: 'FAMILY', exclusive: true }];
      const { controller } = build({
        update: jest.fn().mockRejectedValue(new ChatIdAlreadyLinkedError(conflicts)),
      });
      const r = res();

      await controller.updateChatIds(req({ body }), r);

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'CHAT_ID_ALREADY_LINKED',
        details: { conflicts },
      }));
    });

    it('409 também quando a corrida bate no unique_violation (23505) do banco, SEM constraint reconhecida', async () => {
      const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
      const { controller } = build({ update: jest.fn().mockRejectedValue(pgErr) });
      const r = res();

      await controller.updateChatIds(req({ body }), r);

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHAT_ID_ALREADY_LINKED' }));
    });

    it('409 CHAT_ID_OWNED_BY_SAME_PATIENT quando o mesmo chat_id já é do MESMO paciente noutro papel', async () => {
      // Achado de review 11/08: sem isto, "mover" um grupo entre papéis sem
      // incluir o papel antigo no body virava 23505 → mensagem FALSA de "outro
      // paciente" (é o mesmo).
      const conflicts = [{ chatId: GROUP_A, requestedRole: 'HEALTH_PLAN', currentRole: 'FAMILY' }];
      const { controller } = build({
        update: jest.fn().mockRejectedValue(new ChatIdOwnedBySamePatientRoleError(conflicts)),
      });
      const r = res();

      await controller.updateChatIds(req({ body: { chatIds: { HEALTH_PLAN: GROUP_A } } }), r);

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'CHAT_ID_OWNED_BY_SAME_PATIENT',
        details: { conflicts },
      }));
    });

    it('23505 com constraint patient_chat_ids_one_role_per_chat também vira CHAT_ID_OWNED_BY_SAME_PATIENT', async () => {
      // A mesma corrida do teste acima, só que descoberta pela CONSTRAINT em
      // vez do check prévio (concorrência real batendo direto no banco).
      const pgErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'patient_chat_ids_one_role_per_chat',
      });
      const { controller } = build({ update: jest.fn().mockRejectedValue(pgErr) });
      const r = res();

      await controller.updateChatIds(req({ body }), r);

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHAT_ID_OWNED_BY_SAME_PATIENT' }));
    });

    it('23505 com constraint do índice de exclusividade continua CHAT_ID_ALREADY_LINKED', async () => {
      const pgErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'idx_patient_chat_ids_exclusive_chat',
      });
      const { controller } = build({ update: jest.fn().mockRejectedValue(pgErr) });
      const r = res();

      await controller.updateChatIds(req({ body }), r);

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHAT_ID_ALREADY_LINKED' }));
    });

    it('500 em erro inesperado', async () => {
      const { controller } = build({ update: jest.fn().mockRejectedValue(new Error('boom')) });
      const r = res();
      await controller.updateChatIds(req({ body }), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });

    it('500 para rejeição não-Error', async () => {
      const { controller } = build({ update: jest.fn().mockRejectedValue('texto') });
      const r = res();
      await controller.updateChatIds(req({ body }), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET chat-map (mapa em massa)', () => {
    const ROW = {
      patientId: PATIENT, clickupTaskId: '86a4d52bf',
      chatIds: { FAMILY: GROUP_A, PROVIDERS: GROUP_B },
    };

    it('200 com o mapa das três pontas', async () => {
      const mapExecute = jest.fn().mockResolvedValue({
        patients: [ROW], total: 1, limit: 500, offset: 0, hasMore: false,
      });
      const { controller } = build({ mapExecute });
      const r = res();

      await controller.getChatMap(req({ query: {} as never }), r);

      expect(mapExecute).toHaveBeenCalledWith({});
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith({
        success: true,
        data: { patients: [ROW], total: 1, limit: 500, offset: 0, hasMore: false },
      });
    });

    it('repassa filter, limit e offset', async () => {
      const mapExecute = jest.fn().mockResolvedValue({ patients: [], total: 0, limit: 10, offset: 20, hasMore: false });
      const { controller } = build({ mapExecute });
      await controller.getChatMap(req({ query: { filter: 'unlinked', limit: '10', offset: '20' } as never }), res());
      expect(mapExecute).toHaveBeenCalledWith({ filter: 'unlinked', limit: 10, offset: 20 });
    });

    it('repassa chatId (direção reversa)', async () => {
      const mapExecute = jest.fn().mockResolvedValue({ patients: [], total: 0, limit: 500, offset: 0, hasMore: false });
      const { controller } = build({ mapExecute });
      await controller.getChatMap(req({ query: { chatId: GROUP_A } as never }), res());
      expect(mapExecute).toHaveBeenCalledWith({ chatId: GROUP_A });
    });

    it('400 para filter fora do enum', async () => {
      const mapExecute = jest.fn();
      const { controller } = build({ mapExecute });
      const r = res();
      await controller.getChatMap(req({ query: { filter: 'todos' } as never }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(mapExecute).not.toHaveBeenCalled();
    });

    it('400 para chatId que não é grupo (@c.us)', async () => {
      const { controller } = build();
      const r = res();
      await controller.getChatMap(req({ query: { chatId: '5491162180721@c.us' } as never }), r);
      expect(r.status).toHaveBeenCalledWith(400);
    });

    it('400 para limit acima do teto e para campo desconhecido', async () => {
      const { controller } = build();
      const r1 = res();
      await controller.getChatMap(req({ query: { limit: '5000' } as never }), r1);
      expect(r1.status).toHaveBeenCalledWith(400);

      const r2 = res();
      await controller.getChatMap(req({ query: { foo: 'x' } as never }), r2);
      expect(r2.status).toHaveBeenCalledWith(400);
    });

    it('NÃO depende do kill-switch — é leitura do nosso banco', async () => {
      delete process.env.PATIENT_CHAT_LOOKUP_ENABLED;
      const { controller } = build();
      const r = res();
      await controller.getChatMap(req({ query: {} as never }), r);
      expect(r.status).toHaveBeenCalledWith(200);
    });

    it('500 em erro inesperado', async () => {
      const { controller } = build({ mapExecute: jest.fn().mockRejectedValue(new Error('boom')) });
      const r = res();
      await controller.getChatMap(req({ query: {} as never }), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });

    it('500 para rejeição não-Error', async () => {
      const { controller } = build({ mapExecute: jest.fn().mockRejectedValue('texto') });
      const r = res();
      await controller.getChatMap(req({ query: {} as never }), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });
  });

  it('sem dependências injetadas, instancia os padrões', () => {
    expect(() => new AdminPatientChatIdsController()).not.toThrow();
  });

  describe('GET /chat-groups — a lista da org', () => {
    const LOOKUP = process.env.PATIENT_CHAT_LOOKUP_ENABLED;
    beforeEach(() => { process.env.PATIENT_CHAT_LOOKUP_ENABLED = 'true'; });
    afterAll(() => { process.env.PATIENT_CHAT_LOOKUP_ENABLED = LOOKUP; });

    it('200 com a página, sem o `ok` interno vazando no payload', async () => {
      const groupsExecute = jest.fn().mockResolvedValue({
        ok: true,
        groups: [{ chatId: GROUP_A, chatName: 'Gestión: EnLite <> DAS', memberCount: 16, orgPhone: 'p@c.us', linkedPatientCount: 40 }],
        total: 1, limit: 50, offset: 0, hasMore: false, listTruncated: false,
      });
      const { controller } = build({ groupsExecute });
      const r = res();

      await controller.getChatGroups(req({ query: { search: 'gestion' } }), r);

      expect(groupsExecute).toHaveBeenCalledWith({ search: 'gestion' });
      expect(r.status).toHaveBeenCalledWith(200);
      const payload = r.json.mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data).not.toHaveProperty('ok');
      expect(payload.data.groups[0].linkedPatientCount).toBe(40);
    });

    it('passa limit e offset adiante', async () => {
      const groupsExecute = jest.fn().mockResolvedValue({
        ok: true, groups: [], total: 0, limit: 10, offset: 20, hasMore: false, listTruncated: false,
      });
      const { controller } = build({ groupsExecute });

      await controller.getChatGroups(req({ query: { limit: '10', offset: '20' } }), res());

      expect(groupsExecute).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });

    it('503 quando o kill-switch do lookup está desligado', async () => {
      process.env.PATIENT_CHAT_LOOKUP_ENABLED = 'false';
      const groupsExecute = jest.fn();
      const { controller } = build({ groupsExecute });
      const r = res();

      await controller.getChatGroups(req(), r);

      expect(r.status).toHaveBeenCalledWith(503);
      expect(groupsExecute).not.toHaveBeenCalled();
    });

    it('502 quando o Periskope não responde — não é "achei zero"', async () => {
      const groupsExecute = jest.fn().mockResolvedValue({ ok: false, reason: 'periskope_unavailable' });
      const { controller } = build({ groupsExecute });
      const r = res();

      await controller.getChatGroups(req(), r);

      expect(r.status).toHaveBeenCalledWith(502);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PERISKOPE_UNAVAILABLE' }));
    });

    it.each([
      ['campo desconhecido', { foo: 'x' }],
      ['limit fora da faixa', { limit: '9999' }],
      ['offset negativo', { offset: '-1' }],
    ])('400 para %s, sem chamar o caso de uso', async (_l, query) => {
      const groupsExecute = jest.fn();
      const { controller } = build({ groupsExecute });
      const r = res();

      await controller.getChatGroups(req({ query }), r);

      expect(r.status).toHaveBeenCalledWith(400);
      expect(groupsExecute).not.toHaveBeenCalled();
    });

    it('erro inesperado vira 500 sem vazar a mensagem interna', async () => {
      const groupsExecute = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const { controller } = build({ groupsExecute });
      const r = res();

      await controller.getChatGroups(req(), r);

      expect(r.status).toHaveBeenCalledWith(500);
      expect(JSON.stringify(r.json.mock.calls)).not.toContain('connection terminated');
    });
  });
});
