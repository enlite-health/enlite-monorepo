/**
 * IAnaCarePatientDocumentRepository — porta de domínio para `ana_care_patient_document`
 * (migration 446). Mesmo padrão de nomeação dos irmãos do módulo (`IAxonicoLancamentoRepository`,
 * `IAxonicoApiClient`): porta separada da implementação
 * (`infrastructure/AnaCarePatientDocumentRepository.ts`).
 *
 * Desenho: chave é `anaCarePatientId` (ID do paciente NO ANA CARE), nunca `patients.id` — não há
 * vínculo hoje (ver cabeçalho da migration 446). `insert` NUNCA sobrescreve — é o CHAMADOR
 * (`RegistrarDocumentoPacienteAnaCareUseCase`) quem decide 200 idempotente (mesmo número) ou 409
 * (número diferente) ANTES de gravar, lendo com `findByPatientId` primeiro. `insert` só é chamado
 * quando não existe registro ainda para aquele `anaCarePatientId` — uma segunda tentativa
 * concorrente para o MESMO paciente estoura por violação do índice único
 * (`uq_ana_care_patient_document_patient`), mesmo padrão de corrida de
 * `IAxonicoLancamentoRepository`.
 */

export interface AnaCarePatientDocumentRecord {
  id: string;
  anaCarePatientId: string;
  documentNumber: string;
  documentType: string | null;
  registeredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertAnaCarePatientDocumentParams {
  anaCarePatientId: string;
  /** DNI já normalizado (ver `domain/documentNumber.ts`) — o repositório não normaliza. */
  documentNumber: string;
  documentType: string | null;
  registeredBy: string;
}

export interface IAnaCarePatientDocumentRepository {
  /** Busca o documento registrado para o paciente do Ana Care — `null` = nenhum registrado ainda. */
  findByPatientId(anaCarePatientId: string): Promise<AnaCarePatientDocumentRecord | null>;

  /**
   * Grava o documento de UM paciente novo (sem registro prévio). Nunca faz `ON CONFLICT DO
   * UPDATE` — uma segunda inserção concorrente para o MESMO `anaCarePatientId` PROPAGA a
   * violação de `uq_ana_care_patient_document_patient` (código `23505`) para o chamador.
   */
  insert(params: InsertAnaCarePatientDocumentParams): Promise<AnaCarePatientDocumentRecord>;
}
