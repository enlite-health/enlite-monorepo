import type { TranscriptVaultPort, VaultPutResult } from '../../application/ports/AdmissionImportPorts';
import { TranscriptVaultError } from '../../application/ports/AdmissionImportPorts';

/**
 * Cofre em memória (NODE_ENV=test ou ADMISSION_EXTERNALS=fake) COM a semântica do real: criar só se não existe (o
 * equivalente de `ifGenerationMatch=0`). O 2º `putOnce` do mesmo nome volta `already_exists` e NÃO muda o conteúdo.
 */
export class InMemoryTranscriptVault implements TranscriptVaultPort {
  readonly objects = new Map<string, { body: Buffer; sha256: string; generation: number }>();
  readonly putCalls: string[] = [];
  failWith: TranscriptVaultError | null = null;
  private seq = 0;

  async putOnce(objectName: string, body: Buffer, meta: { sha256: string }): Promise<VaultPutResult> {
    this.putCalls.push(objectName);
    if (this.failWith) throw this.failWith;
    if (this.objects.has(objectName)) return { outcome: 'already_exists' };
    this.seq += 1;
    this.objects.set(objectName, { body, sha256: meta.sha256, generation: this.seq });
    return { outcome: 'created', generation: String(this.seq) };
  }
}
