/**
 * DeletePatientDocumentUseCase — DELETE /patients/:id/documents/:docId (spec 031, FR-014).
 *
 * Exclusão DEFINITIVA (D463, "exclui e ponto"). Na transação: some a linha e, se veio do chat, o
 * arquivo do chat é marcado `deleted_at` (a mensagem passa a mostrar "documento eliminado"). SÓ
 * DEPOIS do commit o objeto sai do bucket (404 = já não existe = sucesso): apagar antes e perder o
 * commit deixaria uma linha apontando para o nada.
 *
 * Falha ao apagar o objeto depois do commit não desfaz nada (a linha já não existe): o objeto vira
 * órfão e o log leva SÓ o UUID do documento e o código — nunca caminho nem nome.
 */
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { withActorContext } from '@shared/database/actorContext';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';
import { PatientDocumentNotFoundError } from '../domain/PatientDocument';

export interface DeletePatientDocumentParams {
  patientId: string;
  docId: string;
}

export class DeletePatientDocumentUseCase {
  constructor(
    private readonly repository: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly storageFactory: () => ConversationAttachmentStorage = () => new ConversationAttachmentStorage(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(pool: Pool, params: DeletePatientDocumentParams): Promise<void> {
    const deleted = await withActorContext(pool, (client) =>
      this.repository.deleteDocument(params.patientId, params.docId, client),
    );
    if (!deleted) throw new PatientDocumentNotFoundError();
    if (!deleted.pathEncrypted) return;

    try {
      const objectPath = await this.enc.decrypt(deleted.pathEncrypted);
      await this.storageFactory().delete(objectPath);
    } catch (err) {
      logger.warn(
        { documentId: params.docId, errorCode: (err as { code?: number | string })?.code ?? null },
        '[DeletePatientDocumentUseCase] linha excluída, objeto NÃO apagado do bucket — vira órfão',
      );
    }
  }
}
