import { KeyManagementServiceClient } from '@google-cloud/kms';

/**
 * Limite de decifra KMS em paralelo (D-01 da spec 022) — acima disso estoura a cota da API.
 * Compartilhado por `ConversationRepository` e `NotificationRepository` (G4, gate da change
 * 022-ux-mencao-e-notificacao): as duas tinham o MESMO valor declarado em duas constantes locais
 * — mesmo teto, duas fontes que podiam divergir em silêncio numa mudança futura.
 */
export const KMS_DECRYPT_CONCURRENCY_LIMIT = 10;

export class KMSEncryptionService {
  private client: KeyManagementServiceClient | null;
  private keyName: string;
  private readonly testMode: boolean;

  constructor() {
    // In test/local environments without GCP credentials, use passthrough mode.
    // Values are base64-encoded so the DB column format is preserved.
    this.testMode = process.env.NODE_ENV === 'test' || process.env.USE_KMS_ENCRYPTION === 'false';

    if (this.testMode) {
      this.client = null;
      this.keyName = 'test-passthrough';
      return;
    }

    const projectId = process.env.GCP_PROJECT_ID || 'enlite-prd';
    const location = process.env.GCP_REGION || 'southamerica-west1';
    const keyRing = process.env.KMS_KEYRING || 'enlite-keyring';
    const keyName = process.env.KMS_KEY_NAME || 'worker-data-key';

    this.client = new KeyManagementServiceClient();
    this.keyName = this.client.cryptoKeyPath(projectId, location, keyRing, keyName);
  }

  /**
   * Criptografa uma string com KMS e retorna o ciphertext em base64.
   * Retorna null para entradas vazias ou nulas — nunca armazena '' como ciphertext,
   * pois '' não é NULL no PostgreSQL e quebraria a semântica do COALESCE.
   */
  async encrypt(plaintext: string | null | undefined): Promise<string | null> {
    if (!plaintext) return null;

    if (this.testMode) {
      return Buffer.from(plaintext, 'utf8').toString('base64');
    }

    try {
      const [result] = await this.client!.encrypt({
        name: this.keyName,
        plaintext: Buffer.from(plaintext, 'utf8'),
      });

      return Buffer.from(result.ciphertext || '').toString('base64');
    } catch (error) {
      console.error('KMS encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Descriptografa um ciphertext em base64 e retorna a string original.
   * Retorna '' para entradas vazias ou nulas (campo não preenchido no banco).
   */
  async decrypt(ciphertext: string | null | undefined): Promise<string> {
    if (!ciphertext) return '';

    if (this.testMode) {
      return Buffer.from(ciphertext, 'base64').toString('utf8');
    }

    try {
      const [result] = await this.client!.decrypt({
        name: this.keyName,
        ciphertext: Buffer.from(ciphertext, 'base64'),
      });

      return Buffer.from(result.plaintext || '').toString('utf8');
    } catch (error) {
      console.error('KMS decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Criptografa múltiplos valores em paralelo para reduzir latência.
   * Retorna um objeto com as mesmas chaves, mas valores criptografados.
   * Valores vazios/null retornam null.
   */
  async encryptBatch<T extends Record<string, string | null | undefined>>(
    data: T
  ): Promise<Record<keyof T, string | null>> {
    const keys = Object.keys(data) as Array<keyof T>;
    
    // Criptografar todos os valores em paralelo
    const encryptPromises = keys.map(async (key) => {
      const value = data[key];
      const encrypted = await this.encrypt(value as string | null | undefined);
      return { key, encrypted };
    });

    const results = await Promise.all(encryptPromises);

    // Reconstruir objeto com valores criptografados
    const encrypted: Record<keyof T, string | null> = {} as any;
    for (const { key, encrypted: value } of results) {
      encrypted[key] = value;
    }

    return encrypted;
  }
}
