import { Router, Request, Response } from 'express';
import multer from 'multer';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { AdminPatientPhotoController } from '../controllers/AdminPatientPhotoController';
import { MAX_PHOTO_BYTES } from '../../infrastructure/PatientPhotoProcessor';

/**
 * Rotas de foto do paciente (spec 018, PR-4; `contracts/patient-header-and-photo.md`). Separadas
 * de `adminPatientsRoutes.ts` (teto de 400 linhas do módulo) e montadas com o MESMO prefixo
 * `/api/admin` no `index.ts`.
 *
 * Documento (prova do consentimento) e consentimento de imagem, que viviam neste mesmo arquivo,
 * foram REMOVIDOS por completo (fix/018-remover-documentos-consentimento) — só a foto fica.
 *
 * Células declaradas AQUI, literais (nunca por variável/loop — `celula-em-closure-nao-entra-no-catalogo`,
 * `scanExpressRouter` só enxerga `perm.require('recurso', 'ação')` com strings literais):
 *  - foto: `patient_identity:write`/`:read` (mesma da identidade).
 *
 * Multer em memória (sem tocar disco) — o limite (`MAX_PHOTO_BYTES`) é o MESMO número usado pelo
 * processor; 413 do multer chega antes do use case rodar.
 */
const uploadPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });

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

  return router;
}
