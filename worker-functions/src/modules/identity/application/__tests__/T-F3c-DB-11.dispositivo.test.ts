/**
 * T-F3c-DB-11 — casos de uso do aparelho da cuidadora (spec 077, D795). Sem banco, sem Firebase real, sem rede:
 * dublês nas portas. A regra "um ativo por cuidadora" é do índice (prova no teste de repositório T-F3c-DB-10 com Postgres real).
 */
import express from 'express';
import request from 'supertest';
import { RegisterDevice } from '../RegisterDevice';
import { RevokeDevice } from '../RevokeDevice';
import { PgWorkerDeviceRepository } from '../../infrastructure/PgWorkerDeviceRepository';
import { FirebaseSessionRevoker } from '../../infrastructure/FirebaseSessionRevoker';
import { createAdminWorkerDeviceRoutes, createWorkerDeviceServiceRoutes } from '../../interfaces/workerDeviceRoutes';
import { WorkerDeviceController } from '../../interfaces/controllers/WorkerDeviceController';
import { PermissionMiddleware } from '../../interfaces/middleware/PermissionMiddleware';
import type { PermissionClient, ResolvedAuthz } from '@modules/identity/permissions';
import type { TokenCipher, WorkerDeviceRepository } from '../../ports/WorkerDeviceRepository';
import type { PushSender } from '../../ports/PushSender';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const mockAuth = {
  revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
  updateUser: jest.fn(),
  deleteUser: jest.fn(),
  setCustomUserClaims: jest.fn(),
};
jest.mock('firebase-admin', () => ({ auth: () => mockAuth }));

const WORKER = '11111111-1111-4111-8111-111111111111';
const INSTALLATION = '22222222-2222-4222-8222-222222222222';

const cipher: TokenCipher = { encrypt: async (p) => `enc:${p}`, decrypt: async (c) => c.replace('enc:', '') };
const push: PushSender = { send: jest.fn().mockResolvedValue(true) };

function repoStub(over: Partial<WorkerDeviceRepository> = {}): WorkerDeviceRepository {
  return {
    registerReplacingActive: jest.fn(),
    findActive: jest.fn(),
    revokeActive: jest.fn().mockResolvedValue({ deviceId: 'dev-1', fcmTokenEnc: 'enc:tok' }),
    confirmWipe: jest.fn(),
    findStatus: jest.fn(),
    findAuthUid: jest.fn().mockResolvedValue('firebase-uid-1'),
    ...over,
  };
}

describe('T-F3c-DB-11 aparelho da cuidadora', () => {
  beforeEach(() => jest.clearAllMocks());

  it('T-F3c-DB-11 revogar derruba as sessões (revokeRefreshTokens) exatamente 1 vez', async () => {
    const uc = new RevokeDevice(repoStub(), new FirebaseSessionRevoker(), push, cipher);
    const res = await uc.execute({ workerId: WORKER, operatorUid: 'op-1' });
    expect(res.isSuccess).toBe(true);
    expect(res.getValue()).toMatchObject({ deviceId: 'dev-1', sessionsRevoked: true, pushSent: true });
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledTimes(1);
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('firebase-uid-1');
  });

  it('T-F3c-DB-11 revogar NÃO altera o estado da conta (nada de updateUser, deleteUser ou claims)', async () => {
    const uc = new RevokeDevice(repoStub(), new FirebaseSessionRevoker(), push, cipher);
    await uc.execute({ workerId: WORKER, operatorUid: 'op-1' });
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
    expect(mockAuth.deleteUser).not.toHaveBeenCalled();
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('T-F3c-DB-11 login em aparelho novo desliga o antigo NA MESMA transação', async () => {
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql.trim().split(/\s+/)[0]);
        return { rows: [{ id: 'novo' }] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    await new PgWorkerDeviceRepository(pool as never).registerReplacingActive({
      workerId: WORKER, installationId: INSTALLATION, publicKey: 'pk', fcmTokenEnc: null,
    });
    expect(pool.connect).toHaveBeenCalledTimes(1); // um único client = uma única transação
    expect(calls).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']); // desliga o antigo ANTES de inserir o novo
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('T-F3c-DB-11 sem a célula worker_device:revoke a rota responde 403 e nada é revogado', async () => {
    const repo = repoStub();
    const controller = new WorkerDeviceController({
      revoke: new RevokeDevice(repo, new FirebaseSessionRevoker(), push, cipher),
    } as never);
    const authz: ResolvedAuthz = {
      uid: 'op-1', tenantId: 't', status: 'ACTIVE', permissions: ['worker:read'], countries: ['AR'],
      groups: [{ id: 'g1', name: 'Recrutador' }], canSimulate: false, simulation: null,
    };
    const client = {
      resolve: jest.fn().mockResolvedValue(authz), can: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn(),
    } as unknown as PermissionClient;
    const permissions = new PermissionMiddleware({
      client,
      audit: { record: jest.fn() },
      env: { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.workers' },
    });
    const auth = { requireStaff: () => (req: express.Request, _r: unknown, next: express.NextFunction) => { req.authContext = { principal: { id: 'op-1', roles: ['recruiter'] } } as never; next(); } };
    const app = express();
    app.use(express.json());
    app.use('/api/admin', createAdminWorkerDeviceRoutes(auth as never, permissions, controller));

    await request(app).post(`/api/admin/workers/${WORKER}/device/revoke`).expect(403);
    expect(repo.revokeActive).not.toHaveBeenCalled();
    expect(mockAuth.revokeRefreshTokens).not.toHaveBeenCalled();

    // controle positivo: com a célula, a MESMA rota chega ao caso de uso (o instrumento enxerga a diferença)
    (client.resolve as jest.Mock).mockResolvedValue({ ...authz, permissions: ['worker_device:revoke'] });
    await request(app).post(`/api/admin/workers/${WORKER}/device/revoke`).expect(200);
    expect(repo.revokeActive).toHaveBeenCalledWith(WORKER, 'op-1');
  });

  it.each([true, false])(
    'T-F3c-DB-11 registrar devolve replacedPrevious=%s do repositório, pelo caso de uso e pela rota de serviço',
    async (replacedPrevious) => {
      const repo = repoStub({
        registerReplacingActive: jest.fn().mockResolvedValue({ deviceId: 'novo', replacedDeviceId: replacedPrevious ? 'velho' : null, replacedPrevious }),
      });
      const register = new RegisterDevice(repo, cipher);
      const res = await register.execute({ workerId: WORKER, installationId: INSTALLATION, publicKey: 'pk' });
      expect(res.getValue()).toEqual({ deviceId: 'novo', replacedPrevious });

      const app = express();
      app.use(express.json());
      const pass: express.RequestHandler = (_req, _res, next) => next();
      app.use('/v1', createWorkerDeviceServiceRoutes(pass, new WorkerDeviceController({ register } as never)));
      const http = await request(app).post(`/v1/workers/${WORKER}/device`).send({ installationId: INSTALLATION, publicKey: 'pk' }).expect(201);
      expect(http.body).toEqual({ success: true, data: { deviceId: 'novo', replacedPrevious } });
    },
  );
});
