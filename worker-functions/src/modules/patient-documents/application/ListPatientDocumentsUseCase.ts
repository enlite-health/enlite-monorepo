/**
 * ListPatientDocumentsUseCase — GET /patients/:id/documents (spec 031, FR-004).
 *
 * A lista tem UMA fonte (`patient_documents`): sobe pela aba ou entrou pelo chat, é a mesma linha.
 * Nenhuma união calculada na leitura. Paciente inexistente — ou de outro país (a RLS o esconde) —
 * é `PatientNotFoundError` (404), nunca lista vazia que pareça "paciente sem documento".
 *
 * `pool` é parâmetro de `execute` (nunca default de construtor): o pool roteado pela sessão da
 * request já carrega o país; molde dos use cases do chat.
 */
import type { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientDocumentRepository } from '../infrastructure/PatientDocumentRepository';
import { PatientNotFoundError, type PatientDocumentDto } from '../domain/PatientDocument';
import { toPatientDocumentDtos } from './toPatientDocumentDtos';

export class ListPatientDocumentsUseCase {
  constructor(
    private readonly repository: PatientDocumentRepository = new PatientDocumentRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {}

  async execute(db: Pool, patientId: string): Promise<PatientDocumentDto[]> {
    if (!(await this.repository.patientExists(patientId, db))) throw new PatientNotFoundError();
    const rows = await this.repository.findByPatient(patientId, db);
    return toPatientDocumentDtos(rows, this.enc);
  }
}
