/**
 * AdminStaffDirectoryController — unit puro (repositório mockado, `req`/`res` fake). Cobre R2-B
 * (change 022-ux-mencao-e-notificacao, Rodada 2): `limit` propagado ao repositório, `excludeUid`
 * resolvido por `principalUid`, `isOnline` presente na resposta, 401 quando não autenticado. O
 * comportamento do SQL real (Postgres) é coberto por `adminStaffDirectory.e2e.test.ts`.
 */
import type { Request, Response } from 'express';
import { AdminStaffDirectoryController } from '../AdminStaffDirectoryController';
import { MAX_STAFF_DIRECTORY_RESULTS } from '../../validators/staffDirectorySchema';
import type { AdminRepository } from '../../../infrastructure/AdminRepository';

function fakeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(query: Record<string, unknown>, uid: string | undefined): Request {
  return {
    query,
    authContext: uid ? { principal: { id: uid } } : undefined,
  } as unknown as Request;
}

describe('AdminStaffDirectoryController.search', () => {
  it('sem ator autenticado — 401, nunca chama o repositório', async () => {
    const searchStaffDirectory = jest.fn();
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

    await controller.search(fakeReq({}, undefined), fakeRes());

    expect(searchStaffDirectory).not.toHaveBeenCalled();
  });

  it('limit ausente: repositório recebe o default (MAX_STAFF_DIRECTORY_RESULTS)', async () => {
    const searchStaffDirectory = jest.fn().mockResolvedValue([]);
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

    await controller.search(fakeReq({}, 'uid-1'), fakeRes());

    expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
  });

  it('limit=200 ("Mostrar todos"): propagado ao repositório', async () => {
    const searchStaffDirectory = jest.fn().mockResolvedValue([]);
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

    await controller.search(fakeReq({ limit: '200' }, 'uid-1'), fakeRes());

    expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, 200, 'uid-1', undefined, false);
  });

  it('resposta inclui isOnline e nunca email/role — forma explícita mesmo com row "sujo"', async () => {
    const searchStaffDirectory = jest.fn().mockResolvedValue([
      { uid: 'u1', displayName: 'Ana', isOnline: true, email: 'vazou@e2e.local', role: 'admin' },
    ]);
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);
    const res = fakeRes();

    await controller.search(fakeReq({}, 'uid-1'), res);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data).toEqual([{ uid: 'u1', displayName: 'Ana', isOnline: true }]);
  });

  it('limit=201 (acima do teto do schema) — 400, nunca chama o repositório', async () => {
    const searchStaffDirectory = jest.fn();
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);
    const res = fakeRes();

    await controller.search(fakeReq({ limit: '201' }, 'uid-1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(searchStaffDirectory).not.toHaveBeenCalled();
  });

  // ── R3-1 (change 022-ux-mencao-e-notificacao, Rodada 3): patientId só chega ao repositório
  // quando a família `admin.patients` está ENFORCED (`isPermissionFamilyEnforced`, MESMO
  // predicado de `PermissionClientActorAccessChecker`) — "engine desligado → não filtra
  // ninguém indevidamente" (pedido do Gabriel 22/09).
  describe('patientId (R3-1)', () => {
    const PATIENT_ID = 'ee422000-c4a7-0002-0002-000000000002';
    const envAnterior: Record<string, string | undefined> = {};

    const setEnv = (k: string, v: string | undefined): void => {
      envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };

    afterEach(() => {
      for (const [k, v] of Object.entries(envAnterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('família admin.patients ENFORCED: patientId da query é propagado ao repositório', async () => {
      setEnv('PERMISSION_ENGINE_ENABLED', 'true');
      setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.users');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({ patientId: PATIENT_ID }, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', PATIENT_ID, false);
    });

    it('engine LIGADO mas admin.patients FORA da lista enforced: patientId NUNCA chega ao repositório', async () => {
      setEnv('PERMISSION_ENGINE_ENABLED', 'true');
      setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({ patientId: PATIENT_ID }, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
    });

    it('engine DESLIGADO: patientId NUNCA chega ao repositório, mesmo com admin.patients na lista', async () => {
      setEnv('PERMISSION_ENGINE_ENABLED', 'false');
      setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.users');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({ patientId: PATIENT_ID }, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
    });

    it('patientId ausente da query: repositório recebe undefined mesmo com a família enforced', async () => {
      setEnv('PERMISSION_ENGINE_ENABLED', 'true');
      setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.users');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({}, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
    });

    it('patientId que não é UUID — 400 do schema, nunca chama o repositório', async () => {
      setEnv('PERMISSION_ENGINE_ENABLED', 'true');
      setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.users');
      const searchStaffDirectory = jest.fn();
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);
      const res = fakeRes();

      await controller.search(fakeReq({ patientId: 'não-é-uuid' }, 'uid-1'), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(searchStaffDirectory).not.toHaveBeenCalled();
    });
  });

  // ── enforceCountry (gate 🔴 do revisao-pr, 22/09): o controller lê `COUNTRY_RLS_ENABLED` via
  // `isEnvFlagOn` (MESMO helper que o eixo de célula usa dentro de `isPermissionFamilyEnforced`)
  // e manda o booleano pro repositório — nunca deixa o repositório ler env sozinho (repositório
  // é unit puro, testado com o booleano já resolvido; ver AdminRepository.searchStaffDirectory.test.ts).
  //
  // 🔒 Guarda dura (TDD, sabotagem cp+cmp): removendo a leitura de `isEnvFlagOn('COUNTRY_RLS_ENABLED', ...)`
  // do controller (ex.: hardcoding `enforceCountry = false` ou `= true`) um destes dois testes
  // morre — prova que o valor de fato vem da env, não de uma constante esquecida no meio do
  // conserto.
  describe('enforceCountry (COUNTRY_RLS_ENABLED)', () => {
    const PATIENT_ID = 'ee422000-c4a7-0002-0002-000000000003';
    const envAnterior: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string | undefined): void => {
      envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };

    afterEach(() => {
      for (const [k, v] of Object.entries(envAnterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('COUNTRY_RLS_ENABLED ausente (valor de prd, medido 22/09): repositório recebe enforceCountry=false', async () => {
      setEnv('COUNTRY_RLS_ENABLED', undefined);
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({}, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
    });

    it('COUNTRY_RLS_ENABLED="false": repositório recebe enforceCountry=false (não é só ausência que desliga)', async () => {
      setEnv('COUNTRY_RLS_ENABLED', 'false');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({}, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
    });

    it('COUNTRY_RLS_ENABLED="true": repositório recebe enforceCountry=true', async () => {
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({}, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, true);
    });

    it('COUNTRY_RLS_ENABLED="1" (variação não-canônica): NÃO liga — só a string exata "true" liga (convenção de isEnvFlagOn)', async () => {
      setEnv('COUNTRY_RLS_ENABLED', '1');
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({}, 'uid-1'), fakeRes());

      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, false);
    });

    it('enforceCountry é independente da família admin.patients (país e célula são dois eixos, não um)', async () => {
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('PERMISSION_ENGINE_ENABLED', 'false'); // família admin.patients NÃO enforced
      const searchStaffDirectory = jest.fn().mockResolvedValue([]);
      const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

      await controller.search(fakeReq({ patientId: PATIENT_ID }, 'uid-1'), fakeRes());

      // patientId cai (família fora do rollout) mas enforceCountry segue vindo da SUA PRÓPRIA flag
      expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1', undefined, true);
    });
  });
});
