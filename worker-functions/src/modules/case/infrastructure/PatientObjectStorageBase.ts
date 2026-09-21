/**
 * PatientObjectStorageBase — base comum de storage de objeto do paciente (spec 018, PR-4).
 * Nasceu como achado de duplicação entre `PatientPhotoStorage` e `PatientDocumentStorage` (as
 * duas tinham `getClient` idêntico e `delete`/`getReadSignedUrl` quase idênticos — só o texto do
 * log mudava). `PatientDocumentStorage` foi REMOVIDA por completo
 * (fix/018-remover-documentos-consentimento) — hoje só `PatientPhotoStorage` estende esta base,
 * mas ela fica: é a classe compartilhada, não específica de foto. Só `uploadBuffer` é de fato
 * específico do bucket (extensão/prefixo do objeto) e continua na subclasse.
 *
 * ⚠️ NÃO usar a env `STORAGE_EMULATOR_HOST` (achado medido em integração real contra
 * fake-gcs-server, docker, spec 018 PR-4): o `@google-cloud/storage` v7 lê essa variável no
 * PRÓPRIO construtor — se ela estiver setada no processo, TODA chamada usa a base SEM o prefixo
 * `/storage/v1`, mesmo quando este código passa `apiEndpoint` explícito. `upload`/`save`
 * funcionam mesmo assim, mas `delete()` sai como `DELETE /b/<bucket>/o/<obj>` — 405 no
 * fake-gcs-server 1.52.2. Por isso a env própria deste projeto é `GCS_EMULATOR_HOST`.
 */
import { Storage, type Bucket } from '@google-cloud/storage';
import { logger } from '@shared/logging';

export const READ_URL_TTL_SECONDS = 300;

let sharedClient: Storage | undefined;

/** Cliente único por processo — reaproveita conexões entre foto e documento. */
function getClient(): Storage {
  if (!sharedClient) {
    const emulatorHost = process.env.GCS_EMULATOR_HOST;
    sharedClient = emulatorHost
      ? new Storage({ apiEndpoint: emulatorHost, projectId: process.env.GCP_PROJECT_ID ?? 'enlite-test' })
      : new Storage(process.env.GCP_PROJECT_ID ? { projectId: process.env.GCP_PROJECT_ID } : undefined);
  }
  return sharedClient;
}

export abstract class PatientObjectStorageBase {
  protected readonly bucketName: string;

  /**
   * @param bucketEnvVar nome da env que carrega o bucket (ex.: `GCS_PATIENT_PHOTOS_BUCKET`) — sem
   *   valor, lança `notConfigured()` (fail-closed, sem fallback de nome).
   * @param notConfigured fábrica do erro específico da subclasse (mensagem/nome próprios).
   */
  protected constructor(
    bucketEnvVar: string,
    notConfigured: () => Error,
    protected readonly client: Storage = getClient(),
  ) {
    const bucket = process.env[bucketEnvVar];
    if (!bucket) throw notConfigured();
    this.bucketName = bucket;
  }

  protected bucket(): Bucket {
    return this.client.bucket(this.bucketName);
  }

  /**
   * Apaga o objeto. Lança se a exclusão falhar por motivo diferente de "já não existe" — quem
   * chama decide o que fazer (grava em `patient_photo_orphans`, task 4.8/L1c).
   */
  async delete(objectPath: string): Promise<void> {
    try {
      await this.bucket().file(objectPath).delete();
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 404) return; // já não existe: sucesso do ponto de vista do chamador
      // Conserto #5 da 2ª revisão do PR-4: NÃO logar `err` inteiro (pino serializa
      // `err.message`/stack) — a mensagem de erro do `@google-cloud/storage` costuma trazer o
      // NOME DO OBJETO (ex.: "No such object: bucket/uuid.jpg"), e este arquivo nunca loga
      // objectPath (comentário do topo do arquivo/lex-pr4-foto #6/#9). Só código/status, que
      // identifica a CLASSE do erro sem carregar o caminho.
      const status = (err as { response?: { status?: number } })?.response?.status;
      logger.warn({ code, status }, `[${this.constructor.name}] falha ao apagar objeto — chamador decide órfão`);
      throw err;
    }
  }

  /**
   * URL v4 de LEITURA, 300s. Chamar só depois de checar a célula — este método não checa nada.
   *
   * `options.responseDisposition` (spec 022, Bloco 3, T315): força o navegador a baixar o objeto
   * com um nome de arquivo escolhido pelo servidor, em vez de abrir inline — usado pelo download
   * de anexo de conversa (`ConversationAttachmentStorage`), que precisa entregar o NOME ORIGINAL
   * decifrado (`stored_files.original_name_encrypted`), nunca o UUID do objeto no bucket. Opcional
   * e aditivo — `PatientPhotoStorage` (foto inline no navegador) não passa a opção e mantém o
   * comportamento de sempre.
   */
  async getReadSignedUrl(objectPath: string, options?: { responseDisposition?: string }): Promise<string> {
    const [url] = await this.bucket().file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + READ_URL_TTL_SECONDS * 1000,
      ...(options?.responseDisposition ? { responseDisposition: options.responseDisposition } : {}),
    });
    return url;
  }
}
