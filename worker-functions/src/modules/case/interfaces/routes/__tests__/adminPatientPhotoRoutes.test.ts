/**
 * adminPatientPhotoRoutes — mede DECLARAÇÃO de célula por rota (mesmo contrato de
 * adminPatientsRoutes.test.ts) e o comportamento HTTP do multer (413 normalizado em JSON) e do
 * corpo/params antes de chegar no controller. Autenticação/célula real é assunto do e2e.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter } from '@modules/identity/permissions';
import { createAdminPatientPhotoRoutes } from '../adminPatientPhotoRoutes';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import type { AdminPatientPhotoController } from '../../controllers/AdminPatientPhotoController';
import type { AdminPatientDocumentController } from '../../controllers/AdminPatientDocumentController';
import type { AdminPatientImageConsentController } from '../../controllers/AdminPatientImageConsentController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));
// O 3º argumento (`idFrom`) É código de produção com lógica própria (extrai `documentId` dos
// params) — o dublê CHAMA-O de verdade (como o middleware real faria no `res.once('finish')`)
// para a linha ficar coberta, sem precisar simular banco/trilha de verdade aqui (isso é o e2e).
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess:
    (_resourceType: unknown, _action: unknown, idFrom?: (req: unknown) => unknown) =>
    (req: unknown, _res: unknown, next: () => void) => {
      idFrom?.(req);
      next();
    },
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

const ESPERADO: Record<string, string> = {
  'POST /patients/:id/photo': 'patient_identity:write',
  'DELETE /patients/:id/photo': 'patient_identity:write',
  'GET /patients/:id/photo': 'patient_identity:read',
  'POST /patients/:id/documents': 'patient_identity:write',
  'GET /patients/:id/documents/:documentId': 'patient_consent_documents:read',
  'POST /patients/:id/image-consents': 'patient_identity:write',
  'POST /patients/:id/image-consents/:cid/revoke': 'patient_identity:write',
};

function buildRouter(controllers: {
  photo?: Partial<AdminPatientPhotoController>;
  document?: Partial<AdminPatientDocumentController>;
  consent?: Partial<AdminPatientImageConsentController>;
} = {}) {
  return createAdminPatientPhotoRoutes(
    authDouble(),
    permissionsDouble(),
    (controllers.photo ?? { upload: (_r, res) => res.status(201).json({}), remove: (_r, res) => res.status(204).send(), getUrl: (_r, res) => res.status(200).json({}) }) as AdminPatientPhotoController,
    (controllers.document ?? { upload: (_r, res) => res.status(201).json({}), getUrl: (_r, res) => res.status(200).json({}) }) as AdminPatientDocumentController,
    (controllers.consent ?? { register: (_r, res) => res.status(201).json({}), revoke: (_r, res) => res.status(200).json({}) }) as AdminPatientImageConsentController,
  );
}

function build(controllers: Parameters<typeof buildRouter>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', buildRouter(controllers));
  return app;
}

describe('createAdminPatientPhotoRoutes (spec 018, PR-4)', () => {
  it('TODA rota declara a célula do contrato (patient-header-and-photo.md)', () => {
    const rotas = scanExpressRouter(buildRouter());
    expect(rotas).toHaveLength(Object.keys(ESPERADO).length);
    for (const rota of rotas) {
      const chave = `${rota.method} ${rota.path}`;
      expect(ESPERADO[chave]).toBeDefined();
      expect(`${rota.cell?.resource}:${rota.cell?.action}`).toBe(ESPERADO[chave]);
    }
  });

  it('a célula NOVA patient_consent_documents:read é declarada literal na rota (não em loop/closure)', () => {
    const rotas = scanExpressRouter(buildRouter());
    const rota = rotas.find((r) => r.method === 'GET' && r.path === '/patients/:id/documents/:documentId');
    expect(rota?.cell).toEqual({ resource: 'patient_consent_documents', action: 'read', description: null });
  });

  it('upload de foto sem arquivo (sem multipart) — chega no controller (400 é responsabilidade dele)', async () => {
    const upload = jest.fn((_req: unknown, res: express.Response) => res.status(400).json({ success: false }));
    const app = build({ photo: { upload, remove: jest.fn(), getUrl: jest.fn() } as never });
    const res = await request(app).post('/api/admin/patients/11111111-1111-1111-1111-111111111111/photo');
    expect(res.status).toBe(400);
    expect(upload).toHaveBeenCalled();
  });

  it('upload de foto ACIMA do limite (multer) — 413 JSON normalizado, controller NUNCA chamado', async () => {
    const upload = jest.fn();
    const app = build({ photo: { upload, remove: jest.fn(), getUrl: jest.fn() } as never });
    const big = Buffer.alloc(6 * 1024 * 1024, 1); // > MAX_PHOTO_BYTES (5MB)
    const res = await request(app)
      .post('/api/admin/patients/11111111-1111-1111-1111-111111111111/photo')
      .attach('file', big, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: 'Arquivo excede o limite', code: 'FILE_TOO_LARGE' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('upload de foto DENTRO do limite — multer popula req.file e chama o controller', async () => {
    let sawFile: unknown;
    const upload = jest.fn((req: express.Request, res: express.Response) => {
      sawFile = (req as express.Request & { file?: Express.Multer.File }).file;
      res.status(201).json({ success: true });
    });
    const app = build({ photo: { upload, remove: jest.fn(), getUrl: jest.fn() } as never });
    const res = await request(app)
      .post('/api/admin/patients/11111111-1111-1111-1111-111111111111/photo')
      .attach('file', Buffer.from('small-jpeg'), { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(sawFile).toBeDefined();
  });

  it('upload de documento ACIMA do limite (10MB) — 413 JSON normalizado', async () => {
    const upload = jest.fn();
    const app = build({ document: { upload, getUrl: jest.fn() } as never });
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    const res = await request(app)
      .post('/api/admin/patients/11111111-1111-1111-1111-111111111111/documents')
      .field('documentType', 'image_consent')
      .attach('file', big, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
  });

  it('GET /photo passa pela trilha logResourceAccess (mockada) sem quebrar', async () => {
    const getUrl = jest.fn((_req: unknown, res: express.Response) => res.status(200).json({ success: true }));
    const app = build({ photo: { upload: jest.fn(), remove: jest.fn(), getUrl } as never });
    const res = await request(app).get('/api/admin/patients/11111111-1111-1111-1111-111111111111/photo');
    expect(res.status).toBe(200);
    expect(getUrl).toHaveBeenCalled();
  });

  it('DELETE /photo chega no controller', async () => {
    const remove = jest.fn((_req: unknown, res: express.Response) => res.status(204).send());
    const app = build({ photo: { upload: jest.fn(), remove, getUrl: jest.fn() } as never });
    const res = await request(app).delete('/api/admin/patients/11111111-1111-1111-1111-111111111111/photo');
    expect(res.status).toBe(204);
    expect(remove).toHaveBeenCalled();
  });

  it('upload de documento DENTRO do limite chega no controller com req.file e req.body.documentType', async () => {
    let seen: { file?: unknown; body?: unknown } = {};
    const upload = jest.fn((req: express.Request, res: express.Response) => {
      seen = { file: (req as express.Request & { file?: unknown }).file, body: req.body };
      res.status(201).json({ success: true });
    });
    const app = build({ document: { upload, getUrl: jest.fn() } as never });
    const res = await request(app)
      .post('/api/admin/patients/11111111-1111-1111-1111-111111111111/documents')
      .field('documentType', 'image_consent')
      .attach('file', Buffer.from('%PDF'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(seen.file).toBeDefined();
    expect(seen.body).toEqual({ documentType: 'image_consent' });
  });

  it('GET /documents/:documentId chega no controller (célula NOVA na rota real)', async () => {
    const getUrl = jest.fn((_req: unknown, res: express.Response) => res.status(200).json({ success: true }));
    const app = build({ document: { upload: jest.fn(), getUrl } as never });
    const res = await request(app).get(
      '/api/admin/patients/11111111-1111-1111-1111-111111111111/documents/22222222-2222-2222-2222-222222222222',
    );
    expect(res.status).toBe(200);
    expect(getUrl).toHaveBeenCalled();
  });

  it('POST /image-consents chega no controller', async () => {
    const register = jest.fn((_req: unknown, res: express.Response) => res.status(201).json({ success: true }));
    const app = build({ consent: { register, revoke: jest.fn() } as never });
    const res = await request(app).post('/api/admin/patients/11111111-1111-1111-1111-111111111111/image-consents').send({});
    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalled();
  });

  it('POST /image-consents/:cid/revoke chega no controller', async () => {
    const revoke = jest.fn((_req: unknown, res: express.Response) => res.status(200).json({ success: true }));
    const app = build({ consent: { register: jest.fn(), revoke } as never });
    const res = await request(app)
      .post('/api/admin/patients/11111111-1111-1111-1111-111111111111/image-consents/22222222-2222-2222-2222-222222222222/revoke')
      .send({});
    expect(res.status).toBe(200);
    expect(revoke).toHaveBeenCalled();
  });

  it('multer com erro DIFERENTE de LIMIT_FILE_SIZE — 400 genérico normalizado', async () => {
    const upload = jest.fn();
    const app = build({ photo: { upload, remove: jest.fn(), getUrl: jest.fn() } as never });
    // 2 arquivos no MESMO campo `file` single() dispara LIMIT_UNEXPECTED_FILE, não LIMIT_FILE_SIZE.
    const res = await request(app)
      .post('/api/admin/patients/11111111-1111-1111-1111-111111111111/photo')
      .attach('file', Buffer.from('a'), 'a.jpg')
      .attach('file', Buffer.from('b'), 'b.jpg');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Falha no upload multipart' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('constrói pelos DEFAULTS do construtor (os 3 controllers)', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b-photos';
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b-docs';
    try {
      const router = createAdminPatientPhotoRoutes(authDouble(), permissionsDouble());
      expect(scanExpressRouter(router)).toHaveLength(Object.keys(ESPERADO).length);
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
      delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    }
  });
});
