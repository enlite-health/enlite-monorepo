/**
 * GetPatientPhotoUrlUseCase — GET /patients/:id/photo. Célula `patient_identity:read` é checada
 * pelo CONTROLLER/rota (`perm.require`) ANTES deste use case rodar — aqui não há checagem de
 * novo, e não há nenhuma chamada de KMS/storage se a rota já barrou.
 */
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientPhotoStorage } from '../infrastructure/PatientPhotoStorage';
import { PatientPhotoRepository } from '../infrastructure/PatientPhotoRepository';

export interface PatientPhotoUrlResult {
  url: string;
  expiresInSeconds: 300;
}

export class GetPatientPhotoUrlUseCase {
  constructor(
    private readonly storage: PatientPhotoStorage = new PatientPhotoStorage(),
    private readonly photoRepo: PatientPhotoRepository = new PatientPhotoRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(patientId: string): Promise<PatientPhotoUrlResult | null> {
    const row = await this.photoRepo.findOne(patientId);
    if (!row) return null;
    const objectPath = await this.enc.decrypt(row.object_path_encrypted);
    const url = await this.storage.getReadSignedUrl(objectPath);
    return { url, expiresInSeconds: 300 };
  }
}
