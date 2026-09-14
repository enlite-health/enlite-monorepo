/**
 * PatientPhotoOrphanRetryService — consome `patient_photo_orphans` (task 4.3h/4.8).
 *
 * Um objeto entra na fila quando `PatientPhotoStorage`/`PatientDocumentStorage` lançou ao apagar
 * (falha real do GCS — 404 já é tratado como sucesso pelo storage, nunca vira órfão). O retry
 * decifra o caminho (KMS), tenta apagar de novo no bucket certo (`bucket` decide a classe de
 * storage) e só remove a linha da fila em caso de sucesso.
 *
 * Alarme (count>0 por >24h) é responsabilidade de quem agenda este serviço (Cloud Scheduler/cron
 * — infra fora do worker-functions); aqui só fica o dado que o alarme consulta
 * (`PatientPhotoOrphanRepository.countOlderThan`).
 */
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientPhotoOrphanRepository, type PatientPhotoOrphanRow } from '../infrastructure/PatientPhotoOrphanRepository';
import { PatientPhotoStorage } from '../infrastructure/PatientPhotoStorage';
import { PatientDocumentStorage } from '../infrastructure/PatientDocumentStorage';

export interface OrphanRetryResult {
  attempted: number;
  cleared: number;
  stillFailing: number;
}

export class PatientPhotoOrphanRetryService {
  constructor(
    private readonly repo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
    private readonly photoStorage: () => PatientPhotoStorage = () => new PatientPhotoStorage(),
    private readonly documentStorage: () => PatientDocumentStorage = () => new PatientDocumentStorage(),
  ) {}

  async retryOnce(limit = 50): Promise<OrphanRetryResult> {
    const pending = await this.repo.listPending(limit);
    let cleared = 0;
    for (const row of pending) {
      // eslint-disable-next-line no-await-in-loop -- retry sequencial de propósito: não queremos
      // N chamadas concorrentes de delete no mesmo bucket num job de fundo.
      const ok = await this.retryOne(row);
      if (ok) cleared += 1;
    }
    return { attempted: pending.length, cleared, stillFailing: pending.length - cleared };
  }

  private async retryOne(row: PatientPhotoOrphanRow): Promise<boolean> {
    try {
      const objectPath = await this.enc.decrypt(row.object_path_encrypted);
      const storage = row.bucket === 'PHOTOS' ? this.photoStorage() : this.documentStorage();
      await storage.delete(objectPath);
      await this.repo.remove(row.id);
      return true;
    } catch (err) {
      logger.warn({ err, orphanId: row.id, bucket: row.bucket }, '[PatientPhotoOrphanRetryService] ainda falhando');
      return false;
    }
  }
}
