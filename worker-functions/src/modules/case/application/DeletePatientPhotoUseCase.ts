/**
 * DeletePatientPhotoUseCase — DELETE /patients/:id/photo (contracts/patient-header-and-photo.md).
 * 204 quando havia foto; `null` (404 no controller) quando não havia.
 */
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { inPatientTransaction } from './patientTransaction';
import { PatientPhotoStorage } from '../infrastructure/PatientPhotoStorage';
import { PatientPhotoRepository } from '../infrastructure/PatientPhotoRepository';
import { PatientPhotoOrphanRepository } from '../infrastructure/PatientPhotoOrphanRepository';

export class DeletePatientPhotoUseCase {
  constructor(
    private readonly storage: PatientPhotoStorage = new PatientPhotoStorage(),
    private readonly photoRepo: PatientPhotoRepository = new PatientPhotoRepository(),
    private readonly orphanRepo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(patientId: string): Promise<{ deleted: boolean }> {
    const deletedRow = await inPatientTransaction((client) => this.photoRepo.deleteRow(patientId, client));
    if (!deletedRow) return { deleted: false };

    const plainPath = await this.enc.decrypt(deletedRow.object_path_encrypted);
    await this.storage.delete(plainPath).catch(async (err) => {
      logger.warn({ err }, '[DeletePatientPhotoUseCase] objeto não apagado — vira órfão');
      await this.orphanRepo.record(deletedRow.object_path_encrypted, 'PHOTOS', 'DELETE');
    });
    return { deleted: true };
  }
}
