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
import { safeStorageErrorFields } from '../infrastructure/safeStorageErrorFields';
import { scheduleOpportunisticOrphanRetry } from './scheduleOpportunisticOrphanRetry';

export interface UploadPatientPhotoInput {
  patientId: string;
  buffer: Buffer;
  actorUid: string;
}

export class UploadPatientPhotoUseCase {
  constructor(
    private readonly processor: PatientPhotoProcessor = new PatientPhotoProcessor(),
    // FÁBRICA, não instância (achado da revisão do PR-4, task 4.3h): `PatientPhotoStorage` lança
    // no `new` sem `GCS_PATIENT_PHOTOS_BUCKET` (fail-closed). Um default `= new PatientPhotoStorage()`
    // aqui derrubaria o BOOT da API inteira quando a env falta — `createAdminPatientPhotoRoutes`
    // constrói este use case (via `AdminPatientPhotoController`) na montagem das rotas. A fábrica só
    // roda dentro de `execute()`, quando a rota de foto é de fato chamada; o resto da API sobe.
    private readonly storageFactory: () => PatientPhotoStorage = () => new PatientPhotoStorage(),
    private readonly photoRepo: PatientPhotoRepository = new PatientPhotoRepository(),
    private readonly orphanRepo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
    private readonly consentRepo: PatientImageConsentRepository = new PatientImageConsentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(input: UploadPatientPhotoInput): Promise<{ hasPhoto: true }> {
    // Constrói ANTES do processamento pesado (sharp): se o bucket não está configurado, falha
    // rápido e barato — `PatientPhotoBucketNotConfiguredError` sobe até o controller, que devolve 503.
    const storage = this.storageFactory();
    const processed = await this.processor.process(input.buffer);
    const { objectPath } = await storage.uploadBuffer(processed.buffer, processed.contentType);
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
      // Best-effort: tenta apagar direto; se a exclusão TAMBÉM falhar, registra o objeto novo em
      // `patient_photo_orphans` (reason `REPLACE`) em vez de deixá-lo desaparecer em silêncio do
      // bucket sem log e sem fila de retry (achado da revisão do PR-4, task 4.3h — `.catch(() =>
      // undefined)` engolia a falha de exclusão inteira). O erro ORIGINAL da transação sempre
      // propaga, coberto ou não o objeto — quem chamou precisa saber que a transação falhou.
      await storage.delete(objectPath).catch(async (deleteErr) => {
        logger.warn(safeStorageErrorFields(deleteErr), '[UploadPatientPhotoUseCase] objeto novo não apagado após falha da transação — vira órfão');
        await this.orphanRepo.record(objectPathEncrypted!, 'PHOTOS', 'REPLACE').catch((orphanErr) => {
          logger.error(safeStorageErrorFields(orphanErr), '[UploadPatientPhotoUseCase] também falhou ao registrar órfão do objeto novo');
        });
      });
      throw err;
    }

    if (oldRow) {
      const oldPath: string = (oldRow as { object_path_encrypted: string }).object_path_encrypted;
      // Achado da 3ª revisão do PR-4 (conserto #2, classe inteira): tudo daqui pra baixo roda
      // DEPOIS do commit acima (a troca de foto já sucedeu). `decrypt` sem try/catch próprio faria
      // o cliente ver 500 numa operação que já tinha sucedido — o `catch` cobre tanto o `decrypt`
      // quanto o `delete`, e em qualquer falha o objeto antigo vira órfão pelo caminho AINDA
      // CIFRADO (registrar o órfão não precisa decriptar).
      try {
        const plainOldPath = await this.enc.decrypt(oldPath);
        await storage.delete(plainOldPath);
      } catch (err) {
        logger.warn(safeStorageErrorFields(err), '[UploadPatientPhotoUseCase] objeto antigo não apagado — vira órfão');
        // Achado da 2ª revisão do PR-4 (conserto #3): `record` sem catch próprio propagava pelo
        // `await` acima e virava 500 mesmo com a transação JÁ COMITADA (troca de foto bem-sucedida).
        // Best-effort até o fim: se também falhar ao registrar o órfão, só loga — a resposta ao
        // cliente reflete o que de fato aconteceu (a foto trocou), não uma falha de limpeza em bg.
        await this.orphanRepo.record(oldPath, 'PHOTOS', 'REPLACE').catch((orphanErr) => {
          logger.error(safeStorageErrorFields(orphanErr), '[UploadPatientPhotoUseCase] também falhou ao registrar órfão do objeto antigo');
        });
      }
    }

    // Achado da revisão do PR-4 (item 3): nada consumia `patient_photo_orphans` — a fila só
    // crescia. Tentativa oportunista, pequena e best-effort (não bloqueia esta resposta, não lança
    // se falhar) no MESMO caminho que alimenta a fila.
    scheduleOpportunisticOrphanRetry();
    return { hasPhoto: true };
  }
}
