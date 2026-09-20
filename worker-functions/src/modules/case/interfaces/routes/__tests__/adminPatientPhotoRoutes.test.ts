/**
 * adminPatientPhotoRoutes — mede DECLARAÇÃO de célula por rota (mesmo contrato de
 * adminPatientsRoutes.test.ts) e o comportamento HTTP do multer (413 normalizado em JSON) e do
 * corpo/params antes de chegar no controller. Autenticação/célula real é assunto do e2e.
 *
 * Documento (prova do consentimento) e consentimento de imagem, que este arquivo também cobria,
 * foram REMOVIDOS por completo (fix/018-remover-documentos-consentimento) — só a foto fica.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter } from '@modules/identity/permissions';
import { createAdminPatientPhotoRoutes } from '../adminPatientPhotoRoutes';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import type { AdminPatientPhotoController } from '../../controllers/AdminPatientPhotoController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));
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
  // PR-8b (8b.4, ADR-2/SUP-30): patient_identity:write splitado — create no que gera registro
  // novo (upload inicial de foto), update no que altera o existente (apagar foto) —
  // pr8b-mapa-rotas.tsv linhas 105-109.
  'POST /patients/:id/photo': 'patient_identity:create',
  'DELETE /patients/:id/photo': 'patient_identity:update',
  'GET /patients/:id/photo': 'patient_identity:read',
};

function buildRouter(controllers: {
  photo?: Partial<AdminPatientPhotoController>;
} = {}) {
  return createAdminPatientPhotoRoutes(
    authDouble(),
    permissionsDouble(),
    (controllers.photo ?? { upload: (_r, res) => res.status(201).json({}), remove: (_r, res) => res.status(204).send(), getUrl: (_r, res) => res.status(200).json({}) }) as AdminPatientPhotoController,
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

  it('constrói pelos DEFAULTS do construtor (o controller de foto)', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b-photos';
    try {
      const router = createAdminPatientPhotoRoutes(authDouble(), permissionsDouble());
      expect(scanExpressRouter(router)).toHaveLength(Object.keys(ESPERADO).length);
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });
});
