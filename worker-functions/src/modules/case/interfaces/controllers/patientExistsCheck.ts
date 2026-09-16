/**
 * patientExistsCheck — achado da revisão do PR-4 (item 5): `AdminPatientPhotoController`,
 * `AdminPatientDocumentController` e `AdminPatientImageConsentController` (as 3 rotas NOVAS desta
 * spec) tinham cada uma sua própria cópia byte-a-byte do mesmo `private async patientExists`.
 * Os dois últimos controllers foram REMOVIDOS por completo (fix/018-remover-documentos-consentimento)
 * — só `AdminPatientPhotoController` usa este helper hoje.
 *
 * Levantamento no módulo (`grep -n "private async patientExists" src/modules/case/interfaces/controllers/*.ts`):
 * já existiam OUTRAS 3 cópias idênticas em controllers mais antigos
 * (`AdminPatientExternalContactsController`, `AdminPatientContactRowsController`,
 * `AdminPatientEmergencyContactController`) — nenhum helper compartilhado pré-existia no módulo
 * pra reaproveitar. Em vez de nascer com uma QUARTA/QUINTA/SEXTA cópia, as rotas NOVAS passaram a
 * usar esta função; as 3 cópias ANTIGAS ficam como estão (fora do escopo desta revisão — mexer
 * nelas é ripple em código que não foi tocado por esta spec).
 */
import type { Pool } from 'pg';

export async function patientExistsCheck(db: Pool, id: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
  return rows.length > 0;
}
