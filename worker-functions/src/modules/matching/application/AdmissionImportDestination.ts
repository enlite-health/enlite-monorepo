import type { StoreAdmissionSummaryDocument } from '@modules/patient-documents/application/StoreAdmissionSummaryDocument';
import type { ImportCandidate } from '../infrastructure/AdmissionImportRepository';
import { dateLabel } from './admissionDateLabels';
import { ADMISSION_IMPORT_NAMING, type ImportDestination, type ImportNaming, type PreparedSummary } from './ports/ImportPorts';

/**
 * Destino da ADMISSÃO (spec 052, T-34a): o que a importação grava ao FIM, exatamente como era antes dos portos — chave do cofre
 * `<país>/<appointmentId>/transcricao-<sha256>.txt`, rótulo `Resumen de admisión · <data>` e o resumo nos documentos do PACIENTE
 * (`StoreAdmissionSummaryDocument`, que não mudou). Embrulha, não copia.
 */
export class AdmissionImportDestination implements ImportDestination<ImportCandidate> {
  readonly naming: ImportNaming = ADMISSION_IMPORT_NAMING;

  constructor(private readonly documents: StoreAdmissionSummaryDocument) {}

  vaultObjectName(a: ImportCandidate, sha256: string): string {
    return `${a.country}/${a.id}/transcricao-${sha256}.txt`;
  }

  summaryLabel(a: ImportCandidate): string {
    return `Resumen de admisión · ${dateLabel(a.slot_start, a.country)}`;
  }

  prepareSummary(a: ImportCandidate, pdf: Buffer, label: string): Promise<PreparedSummary> {
    return this.documents.prepare({
      patientId: a.patient_id, appointmentId: a.id, pdf, originalFilename: `resumen-admision-${a.admission_code}.pdf`, label,
    });
  }
}
