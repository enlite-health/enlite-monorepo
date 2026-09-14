/**
 * UploadPatientPhotoUseCase — POST /patients/:id/photo (spec 018, PR-4; contracts/patient-header-and-photo.md).
 *
 * Decisão 14/09 (D335): SEM checagem de consentimento vigente (removida a L1b/409
 * `IMAGE_CONSENT_REQUIRED`) e SEM checagem de representante para menor (removida L1b'). Upload
 * troca a foto existente incondicionalmente — o `consentId` é anexado quando há um vigente, só
 * como referência informativa (nunca bloqueia).
 *
 * Ordem: processa (sharp, fora do EXIF) → sobe o objeto NOVO → troca a linha em transação → some o
 * objeto ANTIGO (best-effort; falha vira órfão `REPLACE`, task 4.3h).
 */
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { inPatientTransaction } from './patientTransaction';
import { PatientPhotoProcessor } from '../infrastructure/PatientPhotoProcessor';
import { PatientPhotoStorage } from '../infrastructure/PatientPhotoStorage';
import { PatientPhotoRepository } from '../infrastructure/PatientPhotoRepository';
import { PatientPhotoOrphanRepository } from '../infrastructure/PatientPhotoOrphanRepository';
import { PatientImageConsentRepository } from '../infrastructure/PatientImageConsentRepository';

export interface UploadPatientPhotoInput {
  patientId: string;
  buffer: Buffer;
  actorUid: string;
}

export class UploadPatientPhotoUseCase {
  constructor(
    private readonly processor: PatientPhotoProcessor = new PatientPhotoProcessor(),
    private readonly storage: PatientPhotoStorage = new PatientPhotoStorage(),
    private readonly photoRepo: PatientPhotoRepository = new PatientPhotoRepository(),
    private readonly orphanRepo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
    private readonly consentRepo: PatientImageConsentRepository = new PatientImageConsentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(input: UploadPatientPhotoInput): Promise<{ hasPhoto: true }> {
    const processed = await this.processor.process(input.buffer);
    const { objectPath } = await this.storage.uploadBuffer(processed.buffer, processed.contentType);
    const objectPathEncrypted = await this.enc.encrypt(objectPath);

    let oldRow: { object_path_encrypted: string } | null = null;
    try {
      const vigente = await this.consentRepo.findVigente(input.patientId);
      await inPatientTransaction(async (client) => {
        oldRow = await this.photoRepo.deleteRow(input.patientId, client);
        await this.photoRepo.insert(
          input.patientId,
          { objectPathEncrypted: objectPathEncrypted!, consentId: vigente?.id ?? null },
          input.actorUid,
          client,
        );
      });
    } catch (err) {
      // Transação falhou depois do upload: o objeto novo fica órfão (sem linha que o referencie).
      // Best-effort: tenta apagar direto (não passa pela fila — não há linha antiga cifrada aqui
      // que sirva de chave; a fila de órfãos é para objeto que TINHA linha e perdeu).
      await this.storage.delete(objectPath).catch(() => undefined);
      throw err;
    }

    if (oldRow) {
      const oldPath: string = (oldRow as { object_path_encrypted: string }).object_path_encrypted;
      const plainOldPath = await this.enc.decrypt(oldPath);
      await this.storage.delete(plainOldPath).catch(async (err) => {
        logger.warn({ err }, '[UploadPatientPhotoUseCase] objeto antigo não apagado — vira órfão');
        await this.orphanRepo.record(oldPath, 'PHOTOS', 'REPLACE');
      });
    }

    return { hasPhoto: true };
  }
}
