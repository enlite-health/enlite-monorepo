/**
 * IPatientReadPort — porta de leitura de `patients`, criada em F3 (`integracao-axonico`) para o
 * guard 0 de `LancarPrestacaoAxonicoUseCase`.
 *
 * O use case recebe `patientId` (nosso UUID, PK de `patients`), mas `findPatientByDni` (F1, do
 * `IAxonicoApiClient`) exige o DNI. `patients.document_number` é `TEXT` NULLABLE
 * (`migrations/037_create_patients.sql:20`), `patients.id` é `UUID`. Esta porta resolve
 * `document_number` a partir de `patientId` — o use case NÃO faz SQL direto (design.md §F3,
 * "Lacuna patientId → dni").
 *
 * `findDocumentNumber` PRECISA distinguir três casos, porque o guard 0 depende disso:
 *   - paciente não existe → `null` (o objeto todo)
 *   - paciente existe e `document_number` é NULL → `{ documentNumber: null }`
 *   - paciente existe e tem DNI → `{ documentNumber: '<dni>' }`
 * Colapsar os dois primeiros em `null` esconderia "paciente cadastrado sem DNI" atrás de
 * "patientId não existe" — mensagens de erro diferentes, mesma raiz para o guard (ambos recusam
 * antes de tocar rede), mas o chamador que precisar diferenciar (auditoria, mensagem ao operador)
 * fica sem como.
 */

export interface PatientDocumentNumber {
  documentNumber: string | null;
}

export interface IPatientReadPort {
  /**
   * Resolve `document_number` do paciente pelo `patientId`. `null` quando o paciente não existe;
   * `{ documentNumber: null }` quando existe mas não tem DNI cadastrado.
   */
  findDocumentNumber(patientId: string): Promise<PatientDocumentNumber | null>;
}
