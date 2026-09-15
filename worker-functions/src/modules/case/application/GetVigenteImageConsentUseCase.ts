import { PatientImageConsentRepository, type ConsenterKind } from '../infrastructure/PatientImageConsentRepository';

/**
 * GetVigenteImageConsentUseCase — GET /patients/:id/image-consents/vigente (furo fechado nesta
 * rodada: `findVigente` já existia no repositório, mas não tinha rota — o front só sabia do
 * consentimento registrado NA MESMA sessão do navegador). Célula `patient_identity:read` (mesma
 * da foto/identidade — decisão já registrada nos comentários de `adminPatientPhotoRoutes.ts`).
 * `null` quando não há consentimento vigente (nunca registrado, ou revogado — a linha revogada
 * não é "vigente", mas continua existindo para auditoria).
 */
export interface VigenteImageConsentResult {
  id: string;
  consenterKind: ConsenterKind;
  consentedAt: string;
}

export class GetVigenteImageConsentUseCase {
  constructor(private readonly repo: PatientImageConsentRepository = new PatientImageConsentRepository()) {}

  async execute(patientId: string): Promise<VigenteImageConsentResult | null> {
    const row = await this.repo.findVigente(patientId);
    if (!row) return null;
    return { id: row.id, consenterKind: row.consenter_kind, consentedAt: row.consented_at };
  }
}
