import { z } from 'zod';

/**
 * Validadores de foto do paciente (spec 018, PR-4; `contracts/patient-header-and-photo.md`).
 * `.strict()` em todo corpo — campo a mais = 400.
 *
 * Documento (prova) e consentimento de imagem, que este arquivo também validava, foram REMOVIDOS
 * por completo (fix/018-remover-documentos-consentimento).
 */

export const patientIdParamsSchema = z.object({ id: z.string().uuid() });
