import type { Request, Response } from 'express';
import { AdminPatientChatRolesController } from '../AdminPatientChatRolesController';
import {
  PatientChatRolesService,
  ChatRoleNotFoundError,
  ChatRoleAlreadyExistsError,
  ChatRoleInUseError,
  ChatRoleExclusivityConflictError,
} from '../../../application/PatientChatRolesService';

jest.mock('@shared/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));
jest.mock('../../../application/PatientChatRolesService', () => {
  const actual = jest.requireActual('../../../application/PatientChatRolesService');
  return { ...actual, PatientChatRolesService: jest.fn().mockImplementation(() => ({})) };
});

const ROLE = {
  code: 'HEALTH_PLAN',
  labelEs: 'Grupo de la obra social',
  labelPtBr: 'Grupo do plano de saúde',
  isExclusive: false,
  displayOrder: 3,
  isActive: true,
  matchKeywords: ['obra', 'social'],
};

function res(): jest.Mocked<Response> {
  const r = {} as jest.Mocked<Response>;
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.end = jest.fn().mockReturnValue(r);
  return r;
}

function req(over: Partial<Request> = {}): Request {
  return { params: {}, query: {}, body: {}, ...over } as Request;
}

function build(service: Partial<PatientChatRolesService>): AdminPatientChatRolesController {
  return new AdminPatientChatRolesController(service as PatientChatRolesService);
}

describe('AdminPatientChatRolesController', () => {
  describe('GET (list)', () => {
    it('sem query devolve só os ATIVOS, e sem contagem de uso', async () => {
      // A ficha do paciente não tem o que fazer com a contagem, e ela custa uma
      // query por papel.
      const listActive = jest.fn().mockResolvedValue([ROLE]);
      const usageByRole = jest.fn();
      const r = res();

      await build({ listActive, usageByRole }).list(req(), r);

      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.json).toHaveBeenCalledWith({ success: true, data: { roles: [ROLE] } });
      expect(usageByRole).not.toHaveBeenCalled();
    });

    it('?includeInactive=true devolve TODOS mais o `usage` (visão de administração)', async () => {
      const listAll = jest.fn().mockResolvedValue([ROLE]);
      const usageByRole = jest.fn().mockResolvedValue({ HEALTH_PLAN: 4 });
      const r = res();

      await build({ listAll, usageByRole }).list(req({ query: { includeInactive: 'true' } }), r);

      expect(r.json).toHaveBeenCalledWith({
        success: true,
        data: { roles: [ROLE], usage: { HEALTH_PLAN: 4 } },
      });
    });

    it('?includeInactive=false continua sendo o recorte ativo', async () => {
      const listActive = jest.fn().mockResolvedValue([]);
      const listAll = jest.fn();
      const r = res();

      await build({ listActive, listAll }).list(req({ query: { includeInactive: 'false' } }), r);

      expect(listActive).toHaveBeenCalled();
      expect(listAll).not.toHaveBeenCalled();
    });

    it('query desconhecida é 400 (strict), não é ignorada em silêncio', async () => {
      const r = res();
      await build({}).list(req({ query: { includeInactve: 'true' } }), r);
      expect(r.status).toHaveBeenCalledWith(400);
    });

    it('erro do serviço vira 500 sem vazar a mensagem interna', async () => {
      const listActive = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const r = res();

      await build({ listActive }).list(req(), r);

      expect(r.status).toHaveBeenCalledWith(500);
      expect(JSON.stringify(r.json.mock.calls)).not.toContain('connection terminated');
    });
  });

  describe('POST (create)', () => {
    it('201 com a linha criada', async () => {
      const create = jest.fn().mockResolvedValue(ROLE);
      const r = res();

      await build({ create }).create(
        req({ body: { code: 'HEALTH_PLAN', labelEs: 'a', labelPtBr: 'b', isExclusive: false } }),
        r,
      );

      expect(r.status).toHaveBeenCalledWith(201);
      expect(r.json).toHaveBeenCalledWith({ success: true, data: ROLE });
    });

    it('aplica os defaults: exclusivo, ordem 0, sem palavras', async () => {
      // Default EXCLUSIVO é o conservador: recusar aparece como 409 na hora,
      // aceitar envenena a contagem da auditoria em silêncio.
      const create = jest.fn().mockResolvedValue(ROLE);

      await build({ create }).create(
        req({ body: { code: 'MANAGEMENT', labelEs: 'a', labelPtBr: 'b' } }),
        res(),
      );

      expect(create).toHaveBeenCalledWith({
        code: 'MANAGEMENT',
        labelEs: 'a',
        labelPtBr: 'b',
        isExclusive: true,
        displayOrder: 0,
        matchKeywords: [],
      });
    });

    it.each([
      ['código minúsculo', { code: 'family', labelEs: 'a', labelPtBr: 'b' }],
      ['código com espaço', { code: 'HEALTH PLAN', labelEs: 'a', labelPtBr: 'b' }],
      ['rótulo es em branco', { code: 'X', labelEs: '   ', labelPtBr: 'b' }],
      ['rótulo pt em branco', { code: 'X', labelEs: 'a', labelPtBr: '' }],
      ['sem rótulo pt', { code: 'X', labelEs: 'a' }],
      ['campo desconhecido', { code: 'X', labelEs: 'a', labelPtBr: 'b', color: 'red' }],
    ])('400 para %s, sem chamar o serviço', async (_l, body) => {
      const create = jest.fn();
      const r = res();
      await build({ create }).create(req({ body }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(create).not.toHaveBeenCalled();
    });

    it('409 CHAT_ROLE_ALREADY_EXISTS quando o código já existe', async () => {
      const create = jest.fn().mockRejectedValue(new ChatRoleAlreadyExistsError('FAMILY'));
      const r = res();

      await build({ create }).create(
        req({ body: { code: 'FAMILY', labelEs: 'a', labelPtBr: 'b' } }),
        r,
      );

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CHAT_ROLE_ALREADY_EXISTS' }),
      );
    });

    it('23505 (corrida na PK) responde igual ao caminho checado', async () => {
      const create = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
      const r = res();

      await build({ create }).create(
        req({ body: { code: 'FAMILY', labelEs: 'a', labelPtBr: 'b' } }),
        r,
      );

      expect(r.status).toHaveBeenCalledWith(409);
    });
  });

  describe('PATCH (update)', () => {
    it('200 com a linha atualizada', async () => {
      const update = jest.fn().mockResolvedValue(ROLE);
      const r = res();

      await build({ update }).update(
        req({ params: { code: 'HEALTH_PLAN' }, body: { labelEs: 'novo' } }),
        r,
      );

      expect(update).toHaveBeenCalledWith('HEALTH_PLAN', { labelEs: 'novo' });
      expect(r.status).toHaveBeenCalledWith(200);
    });

    it('body VAZIO é 400 — PATCH sem campo nenhum é engano, não no-op', async () => {
      const update = jest.fn();
      const r = res();
      await build({ update }).update(req({ params: { code: 'FAMILY' }, body: {} }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(update).not.toHaveBeenCalled();
    });

    it('mandar `code` no body é 400 — o código é imutável', async () => {
      // Trocar o código de um papel em uso renomearia a chave de join da
      // auditoria da Candela sem que ninguém percebesse.
      const update = jest.fn();
      const r = res();
      await build({ update }).update(
        req({ params: { code: 'FAMILY' }, body: { code: 'FAMILIA' } }),
        r,
      );
      expect(r.status).toHaveBeenCalledWith(400);
      expect(update).not.toHaveBeenCalled();
    });

    it('código malformado no path é 400, não 404 enganoso', async () => {
      const r = res();
      await build({}).update(req({ params: { code: 'health plan' }, body: { labelEs: 'x' } }), r);
      expect(r.status).toHaveBeenCalledWith(400);
    });

    it('404 CHAT_ROLE_NOT_FOUND', async () => {
      const update = jest.fn().mockRejectedValue(new ChatRoleNotFoundError('NOPE'));
      const r = res();

      await build({ update }).update(req({ params: { code: 'NOPE' }, body: { labelEs: 'x' } }), r);

      expect(r.status).toHaveBeenCalledWith(404);
      expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHAT_ROLE_NOT_FOUND' }));
    });

    it('409 CHAT_ROLE_IN_USE com a CONTAGEM na resposta', async () => {
      const update = jest.fn().mockRejectedValue(new ChatRoleInUseError('FAMILY', 21, 'deactivate'));
      const r = res();

      await build({ update }).update(
        req({ params: { code: 'FAMILY' }, body: { isActive: false } }),
        r,
      );

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith({
        success: false,
        error: 'Chat role is in use by 21 patient(s)',
        code: 'CHAT_ROLE_IN_USE',
        details: { code: 'FAMILY', patientCount: 21, operation: 'deactivate' },
      });
    });

    it('409 CHAT_ROLE_EXCLUSIVITY_CONFLICT diz QUANTOS grupos e QUANTOS pacientes', async () => {
      // Sem os números, quem opera não tem como decidir se resolve na mão ou
      // desiste — e a saída seria pedir para alguém abrir o banco.
      const conflicts = [
        { chatId: '1@g.us', patientCount: 3 },
        { chatId: '2@g.us', patientCount: 2 },
      ];
      const update = jest
        .fn()
        .mockRejectedValue(new ChatRoleExclusivityConflictError('HEALTH_PLAN', conflicts));
      const r = res();

      await build({ update }).update(
        req({ params: { code: 'HEALTH_PLAN' }, body: { isExclusive: true } }),
        r,
      );

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot make role exclusive: groups are shared by more than one patient',
        code: 'CHAT_ROLE_EXCLUSIVITY_CONFLICT',
        details: { code: 'HEALTH_PLAN', conflicts, groupCount: 2, patientCount: 5 },
      });
    });

    it('normaliza as palavras de desempate: minúsculas, sem acento, sem repetição', async () => {
      const update = jest.fn().mockResolvedValue(ROLE);

      await build({ update }).update(
        req({ params: { code: 'FAMILY' }, body: { matchKeywords: ['Família', 'FAMILIA', ' flia '] } }),
        res(),
      );

      expect(update).toHaveBeenCalledWith('FAMILY', { matchKeywords: ['familia', 'flia'] });
    });

    it('erro inesperado vira 500', async () => {
      const update = jest.fn().mockRejectedValue(new Error('boom'));
      const r = res();
      await build({ update }).update(req({ params: { code: 'FAMILY' }, body: { labelEs: 'x' } }), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    it('204 sem corpo quando apagou', async () => {
      const del = jest.fn().mockResolvedValue(undefined);
      const r = res();

      await build({ delete: del }).delete(req({ params: { code: 'MANAGEMENT' } }), r);

      expect(r.status).toHaveBeenCalledWith(204);
      expect(r.end).toHaveBeenCalled();
      expect(r.json).not.toHaveBeenCalled();
    });

    it('409 CHAT_ROLE_IN_USE — nada de cascata', async () => {
      const del = jest.fn().mockRejectedValue(new ChatRoleInUseError('FAMILY', 15, 'delete'));
      const r = res();

      await build({ delete: del }).delete(req({ params: { code: 'FAMILY' } }), r);

      expect(r.status).toHaveBeenCalledWith(409);
      expect(r.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'CHAT_ROLE_IN_USE',
          details: { code: 'FAMILY', patientCount: 15, operation: 'delete' },
        }),
      );
    });

    it('404 quando o papel não existe', async () => {
      const del = jest.fn().mockRejectedValue(new ChatRoleNotFoundError('NOPE'));
      const r = res();
      await build({ delete: del }).delete(req({ params: { code: 'NOPE' } }), r);
      expect(r.status).toHaveBeenCalledWith(404);
    });

    it('código malformado é 400, sem chamar o serviço', async () => {
      const del = jest.fn();
      const r = res();
      await build({ delete: del }).delete(req({ params: { code: '1FAMILY' } }), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(del).not.toHaveBeenCalled();
    });

    it('erro inesperado vira 500', async () => {
      const del = jest.fn().mockRejectedValue(new Error('boom'));
      const r = res();
      await build({ delete: del }).delete(req({ params: { code: 'FAMILY' } }), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });
  });

  it('sem serviço injetado, instancia o padrão', () => {
    expect(() => new AdminPatientChatRolesController()).not.toThrow();
  });
});
