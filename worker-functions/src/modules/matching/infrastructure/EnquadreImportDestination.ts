import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { StoreAdmissionSummaryDocument } from '@modules/patient-documents/application/StoreAdmissionSummaryDocument';
import { dateLabel } from '../application/admissionDateLabels';
import type { AdmissionSummaryInput } from '../application/ports/AdmissionImportPorts';
import type { ImportDestination, ImportNaming, PreparedSummary } from '../application/ports/ImportPorts';
import { EnquadreSummaryDocumentRepository } from './EnquadreSummaryDocumentRepository';
import type { EnquadreImportSubject } from './EnquadreImportRepository';

export const ENQUADRE_IMPORT_NAMING: ImportNaming = { prefix: 'enquadre', idKey: 'eventId', lockNamespace: 'enquadre_import' };
export const ENQUADRE_IMPORT_ACTOR_UID = 'system:enquadre-import';
/** Prefixo do PDF do enquadre no bucket de documentos (o do paciente é `patient-documents`): outro caminho, mesmo bucket. */
export const ENQUADRE_DOCUMENTS_OBJECT_PREFIX = 'enquadre-documents';

/**
 * O DESTINO da importação do ENQUADRE (porto `ImportDestination`, spec 052, Fase 3):
 *  - cofre: `<país>/enquadre/<event_id>/transcricao-<sha256>.txt` (só criação, bucket do enquadre);
 *  - resumo: o PDF sobe pela MESMA classe da admissão (`StoreAdmissionSummaryDocument.prepareWith`: mesmo bucket de documentos, caminho,
 *    nome e rótulo cifrados, sha256), sob o prefixo do enquadre, e a LINHA vai para `enquadre_event_documents` — nunca para os
 *    documentos do paciente (sem a quinta célula, ninguém que lê documentos do paciente veria o resumo);
 *  - entrada do resumo: a lista de convocados (`ref` = id da participação, `nombre` decifrado). Só vai ao Vertex.
 */
export interface EnquadreImportDestinationDeps {
  db?: Pool;
  store?: StoreAdmissionSummaryDocument;
  documents?: EnquadreSummaryDocumentRepository;
  decryptor?: Pick<KMSEncryptionService, 'decrypt'>;
}

export class EnquadreImportDestination implements ImportDestination<EnquadreImportSubject> {
  readonly naming = ENQUADRE_IMPORT_NAMING;

  constructor(private readonly deps: EnquadreImportDestinationDeps = {}) {}

  vaultObjectName(e: EnquadreImportSubject, sha256: string): string {
    return `${e.country}/enquadre/${e.id}/transcricao-${sha256}.txt`;
  }

  summaryLabel(e: EnquadreImportSubject): string {
    return `Resumen de encuadre · ${dateLabel(e.slot_start, e.country)}`;
  }

  prepareSummary(e: EnquadreImportSubject, pdf: Buffer, label: string, promptVersion: string): Promise<PreparedSummary> {
    const documents = this.deps.documents ?? new EnquadreSummaryDocumentRepository();
    return (this.deps.store ?? new StoreAdmissionSummaryDocument()).prepareWith(
      { pdf, originalFilename: `resumen-encuadre-${e.admission_code}.pdf`, label, objectPrefix: ENQUADRE_DOCUMENTS_OBJECT_PREFIX },
      (row, client) => documents.insert({ eventId: e.id, ...row, promptVersion, createdByUid: ENQUADRE_IMPORT_ACTOR_UID }, client),
    );
  }

  /** Os convocados do evento (participações ativas ou carimbadas no fecho; as `removed` não): só `ref` interna + nome. */
  async summaryInput(e: EnquadreImportSubject): Promise<Pick<AdmissionSummaryInput, 'convocados'>> {
    const db = this.deps.db ?? DatabaseConnection.getInstance().getPool();
    const dec = this.deps.decryptor ?? new KMSEncryptionService();
    const { rows } = await db.query<{ id: string; first_name_encrypted: string | null; last_name_encrypted: string | null }>(
      `SELECT p.id, w.first_name_encrypted, w.last_name_encrypted
         FROM enquadre_event_participants p
         JOIN workers w ON w.id = p.worker_id
        WHERE p.event_id = $1 AND (p.release_kind IS NULL OR p.release_kind IN ('closed', 'cancelled'))
        ORDER BY p.created_at, p.id`,
      [e.id],
    );
    const convocados = [];
    for (const r of rows) {
      const nombre = `${await dec.decrypt(r.first_name_encrypted)} ${await dec.decrypt(r.last_name_encrypted)}`.trim();
      convocados.push({ ref: r.id, nombre });
    }
    return { convocados };
  }
}
