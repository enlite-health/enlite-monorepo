import type { Request, Response } from 'express';
import { AdminPatientChatIdsController } from '../AdminPatientChatIdsController';
import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
} from '../../../application/PatientChatIdsService';
import { FindPatientChatCandidatesUseCase } from '../../../application/FindPatientChatCandidatesUseCase';

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
} = {}) {
  const service = { update: over.update ?? jest.fn() } as unknown as PatientChatIdsService;
  const finder = { execute: over.execute ?? jest.fn() } as unknown as FindPatientChatCandidatesUseCase;
  return { controller: new AdminPatientChatIdsController(service, finder), service, finder };
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
    const body = { familyChatId: GROUP_A, providersChatId: GROUP_B };

    it('200 e devolve o par gravado', async () => {
      const update = jest.fn().mockResolvedValue(body);
      const { controller } = build({ update });
      const r = res();

      await controller.updateChatIds(req({ body }), r);

      expect(update).toHaveBeenCalledWith(PATIENT, body);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith({ success: true, data: { id: PATIENT, ...body } });
    });

    it('não exige a flag de lookup — gravar é caminho interno', async () => {
      delete process.env.PATIENT_CHAT_LOOKUP_ENABLED;
      const update = jest.fn().mockResolvedValue(body);
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
      await controller.updateChatIds(req({ body: { familyChatId: '549116@c.us', providersChatId: null } }), r);
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
      const conflicts = [{ chatId: GROUP_A, patientId: 'outro', role: 'family' as const }];
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

    it('409 também quando a corrida bate no unique_violation (23505) do banco', async () => {
      const pgErr = Object.assign(new Error('duplicate key'), { code: '23505' });
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

  it('sem dependências injetadas, instancia os padrões', () => {
    expect(() => new AdminPatientChatIdsController()).not.toThrow();
  });
});
