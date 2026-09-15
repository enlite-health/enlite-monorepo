import { Router, Request, Response } from 'express';
import multer from 'multer';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { AdminPatientPhotoController } from '../controllers/AdminPatientPhotoController';
import { AdminPatientDocumentController } from '../controllers/AdminPatientDocumentController';
import { AdminPatientImageConsentController } from '../controllers/AdminPatientImageConsentController';
import { MAX_PHOTO_BYTES } from '../../infrastructure/PatientPhotoProcessor';
import { MAX_DOCUMENT_BYTES } from '../../application/UploadPatientDocumentUseCase';

/**
 * Rotas de foto, documento (prova) e consentimento de imagem do paciente (spec 018, PR-4;
 * `contracts/patient-header-and-photo.md`). Separadas de `adminPatientsRoutes.ts` (teto de 400
 * linhas do módulo) e montadas com o MESMO prefixo `/api/admin` no `index.ts`.
 *
 * Células declaradas AQUI, literais (nunca por variável/loop — `celula-em-closure-nao-entra-no-catalogo`,
 * `scanExpressRouter` só enxerga `perm.require('recurso', 'ação')` com strings literais):
 *  - foto e consentimento: `patient_identity:write`/`:read` (mesma da identidade — decisão de não
 *    criar célula nova para isso, só para a LEITURA da prova).
 *  - documento (prova): escrita sob `patient_identity:write` (é o operador que já edita a
 *    identidade quem anexa a prova); LEITURA sob a célula NOVA `patient_consent_documents:read`
 *    (0 grupos ao nascer — D285, sync do catálogo no boot via `scanExpressRouter`).
 *
 * Multer em memória (sem tocar disco) — os limites (`MAX_PHOTO_BYTES`/`MAX_DOCUMENT_BYTES`) são o
 * MESMO número usado pelo processor/use case; 413 do multer chega antes do use case rodar.
 */
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });
const uploadDocument = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } });

/** multer devolve 413 puro (sem JSON) quando o arquivo estoura o limite — normaliza a resposta. */
function withMulterErrorAsJson(mw: ReturnType<typeof multer>) {
  return (fieldName: string) => (req: Request, res: Response, next: (err?: unknown) => void) => {
    mw.single(fieldName)(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'LIMIT_FILE_SIZE') { res.status(413).json({ success: false, error: 'Arquivo excede o limite', code: 'FILE_TOO_LARGE' }); return; }
        res.status(400).json({ success: false, error: 'Falha no upload multipart' });
        return;
      }
      next();
    });
  };
}

export function createAdminPatientPhotoRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  photoController: AdminPatientPhotoController = new AdminPatientPhotoController(),
  documentController: AdminPatientDocumentController = new AdminPatientDocumentController(),
  consentController: AdminPatientImageConsentController = new AdminPatientImageConsentController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  // ── Foto de perfil (spec 018, PR-4, `lex` #1) ────────────────────────────────────────────────
  router.post(
    '/patients/:id/photo',
    staffOnly,
    perm.require('patient_identity', 'create'),
    withMulterErrorAsJson(uploadPhoto)('file'),
    (req: Request, res: Response) => photoController.upload(req, res),
  );
  router.delete('/patients/:id/photo', staffOnly, perm.require('patient_identity', 'update'), (req: Request, res: Response) =>
    photoController.remove(req, res),
  );
  router.get(
    '/patients/:id/photo',
    staffOnly,
    perm.require('patient_identity', 'read'),
    logResourceAccess('patient', 'read_photo'),
    (req: Request, res: Response) => photoController.getUrl(req, res),
  );

  // ── Documento — prova do consentimento (spec 018, PR-4, D329) ───────────────────────────────
  router.post(
    '/patients/:id/documents',
    staffOnly,
    perm.require('patient_identity', 'create'),
    withMulterErrorAsJson(uploadDocument)('file'),
    (req: Request, res: Response) => documentController.upload(req, res),
  );
  // Célula NOVA, literal aqui (é o ÚNICO call site — o que a sincroniza no catálogo no boot).
  router.get(
    '/patients/:id/documents/:documentId',
    staffOnly,
    perm.require('patient_consent_documents', 'read'),
    logResourceAccess('patient_document', 'read_document', (req) => req.params.documentId),
    (req: Request, res: Response) => documentController.getUrl(req, res),
  );
  // Furo fechado nesta rodada (revisão pré-gate): listagem de metadados — mesma célula da leitura
  // individual acima, SEM URL assinada (a URL continua exclusiva do GET por `documentId`).
  router.get(
    '/patients/:id/documents',
    staffOnly,
    perm.require('patient_consent_documents', 'read'),
    (req: Request, res: Response) => documentController.list(req, res),
  );

  // ── Consentimento de imagem (opcional — decisão 14/09, D335) ────────────────────────────────
  router.post('/patients/:id/image-consents', staffOnly, perm.require('patient_identity', 'create'), (req: Request, res: Response) =>
    consentController.register(req, res),
  );
  // Furo fechado nesta rodada: `findVigente` já existia no repositório, sem rota — mesma célula
  // `patient_identity:read` da foto/identidade (sem célula nova).
  router.get(
    '/patients/:id/image-consents/vigente',
    staffOnly,
    perm.require('patient_identity', 'read'),
    (req: Request, res: Response) => consentController.getVigente(req, res),
  );
  router.post(
    '/patients/:id/image-consents/:cid/revoke',
    staffOnly,
    perm.require('patient_identity', 'update'),
    (req: Request, res: Response) => consentController.revoke(req, res),
  );

  return router;
}
