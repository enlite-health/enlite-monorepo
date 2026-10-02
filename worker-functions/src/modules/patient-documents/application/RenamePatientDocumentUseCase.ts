/**
 * RenamePatientDocumentUseCase — PATCH /patients/:id/documents/:docId (spec 031, FR-013).
 *
 * Só o NOME do documento na lista muda (nome do arquivo na mensagem do chat segue o original).
 * Nome inválido recusa ANTES de abrir transação (o nome antigo fica). A escrita grava quem e quando
 * renomeou (`label_updated_*`) — única coluna editável da tabela, com a trilha.
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';
import { normalizeDocumentLabel, PatientDocumentNotFoundError, type PatientDocumentDto } from '../domain/PatientDocument';
import { toPatientDocumentDtos } from './toPatientDocumentDtos';

export interface RenamePatientDocumentParams {
  patientId: string;
  docId: string;
  actorUid: string;
  label: unknown;
}

export class RenamePatientDocumentUseCase {
  constructor(
    private readonly repository: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(pool: Pool, params: RenamePatientDocumentParams): Promise<PatientDocumentDto> {
    const label = normalizeDocumentLabel(params.label);
    const labelEncrypted = (await this.enc.encrypt(label)) as string;

    const renamed = await withActorContext(pool, (client) =>
      this.repository.renameLabel(
        { patientId: params.patientId, docId: params.docId, labelEncrypted, actorUid: params.actorUid },
        client,
      ),
    );
    if (!renamed) throw new PatientDocumentNotFoundError();

    const rows = await this.repository.findByPatient(params.patientId, pool, params.docId);
    return (await toPatientDocumentDtos(rows, this.enc))[0];
  }
}
