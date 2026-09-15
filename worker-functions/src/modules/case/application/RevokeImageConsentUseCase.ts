/**
 * RevokeImageConsentUseCase — POST /patients/:id/image-consents/:cid/revoke.
 *
 * Decisão 14/09 (D335): revogação SIMPLES — sem regra de retenção/prova como trava (removida
 * L1k/C5/L1f). O único comportamento que fica: revogar APAGA A FOTO (linha + objeto) na mesma
 * operação lógica; documento de revogação é OPCIONAL (CCyC art. 55, "nunca depende de papel").
 */
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { inPatientTransaction } from './patientTransaction';
import { PatientImageConsentRepository, type RevokeImageConsentInput } from '../infrastructure/PatientImageConsentRepository';
import { PatientPhotoRepository, type PatientPhotoRow } from '../infrastructure/PatientPhotoRepository';
import { PatientPhotoStorage } from '../infrastructure/PatientPhotoStorage';
import { PatientPhotoOrphanRepository } from '../infrastructure/PatientPhotoOrphanRepository';
import { scheduleOpportunisticOrphanRetry } from './scheduleOpportunisticOrphanRetry';

export class RevokeImageConsentUseCase {
  constructor(
    private readonly consentRepo: PatientImageConsentRepository = new PatientImageConsentRepository(),
    private readonly photoRepo: PatientPhotoRepository = new PatientPhotoRepository(),
    // FÁBRICA, não instância — mesmo achado de `UploadPatientPhotoUseCase` (task 4.3h): não
    // derrubar o boot da API quando `GCS_PATIENT_PHOTOS_BUCKET` falta.
    private readonly storageFactory: () => PatientPhotoStorage = () => new PatientPhotoStorage(),
    private readonly orphanRepo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(
    patientId: string,
    consentId: string,
    input: RevokeImageConsentInput,
    actorUid: string,
  ): Promise<{ revoked: boolean }> {
    let deletedPhoto: PatientPhotoRow | null = null;
    const revoked = await inPatientTransaction(async (client) => {
      const r = await this.consentRepo.revoke(patientId, consentId, input, actorUid, client);
      if (!r) return null;
      deletedPhoto = await this.photoRepo.deleteRow(patientId, client);
      return r;
    });
    if (!revoked) return { revoked: false };

    if (deletedPhoto) {
      const path = (deletedPhoto as PatientPhotoRow).object_path_encrypted;
      const plainPath = await this.enc.decrypt(path);
      await this.storageFactory().delete(plainPath).catch(async (err) => {
        logger.warn({ err }, '[RevokeImageConsentUseCase] foto não apagada — vira órfão');
        await this.orphanRepo.record(path, 'PHOTOS', 'REVOKE');
      });
    }
    // Achado da revisão do PR-4 (item 3): fila de órfãos sem consumidor — tentativa oportunista.
    scheduleOpportunisticOrphanRetry();
    return { revoked: true };
  }
}
