import { Storage } from '@google-cloud/storage';
import { AdmissionRealAdapterInTestError } from '../application/ports/AdmissionMessagingPorts';
import { TranscriptVaultError, type RehearsalVaultPort, type TranscriptVaultPort, type VaultPutResult } from '../application/ports/AdmissionImportPorts';

export interface GcsTranscriptVaultOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Cliente do Storage. Só para provar o adapter contra um EMULADOR local (fake-gcs-server). Em NODE_ENV=test um cliente
   * injetado só é aceito se o endpoint NÃO for o do Google — o teste nunca toca bucket real (spec 049, regra transversal 2).
   */
  client?: Storage;
  /** Nome da env que guarda o bucket. Padrão: o cofre de 5 anos. O bucket de ENSAIO (R-29) usa `ADMISSION_REHEARSAL_BUCKET`. */
  bucketEnv?: string;
}

export const VAULT_BUCKET_ENV = 'ADMISSION_TRANSCRIPT_VAULT_BUCKET';
export const REHEARSAL_BUCKET_ENV = 'ADMISSION_REHEARSAL_BUCKET';

/**
 * Cofre da transcrição crua (spec 049 §4.4): bucket dedicado, CMEK como chave padrão do bucket, e este adapter SÓ CRIA.
 *
 *  - `putOnce`: escrita com `preconditionOpts: { ifGenerationMatch: 0 }` — o GCS recusa (412) se o objeto já existe. 412 vira
 *    `already_exists` (idempotente); NUNCA sobrescreve;
 *  - sem ler, listar, apagar: a porta tem um método só, e a conta de serviço de prd só terá `roles/storage.objectCreator` (F8);
 *  - bucket em `ADMISSION_TRANSCRIPT_VAULT_BUCKET` (ou, na instância de ensaio, `ADMISSION_REHEARSAL_BUCKET`), lido na CHAMADA (sem a env o boot da API não cai; o `putOnce` falha com
 *    `not_configured`);
 *  - nenhum erro carrega nome de objeto nem corpo: só o `reason`.
 *
 * ⚠️ Lança no construtor com NODE_ENV=test (sem cliente de emulador): teste nunca toca o Google.
 */
export class GcsTranscriptVault implements TranscriptVaultPort, RehearsalVaultPort {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bucketEnv: string;
  private readonly client: Storage;

  constructor(options: GcsTranscriptVaultOptions = {}) {
    this.env = options.env ?? process.env;
    this.bucketEnv = options.bucketEnv ?? VAULT_BUCKET_ENV;
    if (this.env.NODE_ENV === 'test') {
      const endpoint = options.client?.apiEndpoint;
      if (!options.client || !endpoint || endpoint.includes('googleapis.com')) {
        throw new AdmissionRealAdapterInTestError('new GcsTranscriptVault()');
      }
    }
    this.client = options.client ?? new Storage(this.env.GCP_PROJECT_ID ? { projectId: this.env.GCP_PROJECT_ID } : undefined);
  }

  /**
   * O bucket desta instância está definido? Vazio = não. Instância de ENSAIO com o MESMO bucket do cofre também NÃO conta:
   * seria transcrição de ensaio no cofre de 5 anos (R-29: nunca o contrário).
   */
  isConfigured(): boolean {
    const bucket = this.env[this.bucketEnv];
    if (!bucket) return false;
    return this.bucketEnv === VAULT_BUCKET_ENV || bucket !== this.env[VAULT_BUCKET_ENV];
  }

  async putOnce(objectName: string, body: Buffer, meta: { sha256: string }): Promise<VaultPutResult> {
    if (!this.isConfigured()) throw new TranscriptVaultError('not_configured');
    const bucket = this.env[this.bucketEnv] as string;
    const file = this.client.bucket(bucket).file(objectName);
    try {
      await file.save(body, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'private, max-age=0, no-store', metadata: { sha256: meta.sha256 } },
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 412) return { outcome: 'already_exists' };
      throw new TranscriptVaultError('write_failed');
    }
    const generation = (file.metadata as { generation?: string | number } | undefined)?.generation;
    return { outcome: 'created', generation: generation === undefined ? null : String(generation) };
  }
}
