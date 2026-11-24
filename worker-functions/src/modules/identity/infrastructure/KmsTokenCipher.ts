import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { TokenCipher } from '../ports/WorkerDeviceRepository';

/** Token FCM cifrado com o KMS da casa (o mesmo dos dados do prestador). Em teste/local o serviço é passthrough base64. */
export class KmsTokenCipher implements TokenCipher {
  constructor(private readonly kms: Pick<KMSEncryptionService, 'encrypt' | 'decrypt'> = new KMSEncryptionService()) {}

  encrypt(plain: string): Promise<string | null> {
    return this.kms.encrypt(plain);
  }

  decrypt(cipher: string): Promise<string> {
    return this.kms.decrypt(cipher);
  }
}
