/**
 * Destino da importação para a ADMISSÃO (spec 052, T-34a): o adaptador que embrulha `StoreAdmissionSummaryDocument` devolve
 * EXATAMENTE o que o serviço fazia antes dos portos (chave do cofre, rótulo, nome do arquivo, nomes de log e de trava).
 */
import type { StoreAdmissionSummaryDocument } from '@modules/patient-documents/application/StoreAdmissionSummaryDocument';
import type { ImportCandidate } from '../../infrastructure/AdmissionImportRepository';
import { AdmissionImportDestination } from '../AdmissionImportDestination';
import { ADMISSION_IMPORT_NAMING, type PreparedSummary } from '../ports/ImportPorts';

const cand: ImportCandidate = {
  id: 'appt-1', patient_id: 'pat-1', country: 'AR', host_email: 'h@example.test', admission_code: 'ADM-ABC123',
  slot_start: new Date('2026-10-14T15:00:00Z'), status: 'booked', conference_ended_at: null, import_status: 'pending',
  import_attempts: 0, patient_is_test: false, rehearsal_until: null,
};

describe('AdmissionImportDestination (a admissão como destino da importação)', () => {
  const prepared: PreparedSummary = { commit: async () => ({ outcome: 'duplicate' }), discard: async () => undefined };
  const prepare = jest.fn(async () => prepared);
  const dest = new AdmissionImportDestination({ prepare } as unknown as StoreAdmissionSummaryDocument);

  it('chave do cofre = <país>/<id>/transcricao-<sha256>.txt; nomes de log e de trava da admissão', () => {
    expect(dest.vaultObjectName(cand, 'f'.repeat(64))).toBe(`AR/appt-1/transcricao-${'f'.repeat(64)}.txt`);
    expect(dest.naming).toEqual({ prefix: 'admission', idKey: 'appointmentId', lockNamespace: 'admission_import' });
    expect(dest.naming).toBe(ADMISSION_IMPORT_NAMING);
  });

  it('rótulo em es-AR no fuso do país e a gravação vai ao documento do PACIENTE com o nome de arquivo de sempre', async () => {
    const label = dest.summaryLabel(cand);
    expect(label).toBe('Resumen de admisión · 14/10/2026');
    const out = await dest.prepareSummary(cand, Buffer.from('pdf'), label);
    expect(out).toBe(prepared);
    expect(prepare).toHaveBeenCalledWith({
      patientId: 'pat-1', appointmentId: 'appt-1', pdf: Buffer.from('pdf'), originalFilename: 'resumen-admision-ADM-ABC123.pdf', label,
    });
  });
});
