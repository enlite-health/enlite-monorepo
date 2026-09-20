/**
 * AnaCareApiSourceReader — lê a coleção de pacientes do Ana Care por API como
 * FONTE (spec 003, R0 — decisão do Gabriel 27/08: API, não arquivo).
 *
 * `externalId` = id do paciente no Ana Care (vira patients.ana_care_id).
 * Tradução de campos por `source_field_map(ANACARE)`. API indisponível
 * (`AnaCarePatientApiUnavailableError`) → fatalError declarado, nada lido.
 */
import type { PatientSourceReader, SourceReadResult, SourceRecord } from '../domain/PatientSourceReader';
import type { Country } from '../domain/enums';
import { AnaCarePatientApiUnavailableError, type AnaCarePatientApi } from '../domain/AnaCarePatientApi';
import type { FieldMapEntry } from './FieldMapRepository';
import { fieldsToCanonical } from './fieldsToCanonical';

export interface AnaCareApiReadResult extends SourceReadResult {
  /** nomes de campo que a API trouxe e o mapa não conhece (união, sem valores). */
  readonly unmappedFields: readonly string[];
}

export class AnaCareApiSourceReader implements PatientSourceReader {
  readonly source = 'ANACARE' as const;

  constructor(
    private readonly api: AnaCarePatientApi,
    private readonly fieldMap: readonly FieldMapEntry[],
    readonly country: Country,
  ) {}

  async read(): Promise<AnaCareApiReadResult> {
    const base = { source: this.source, country: this.country };
    let page;
    try {
      page = await this.api.fetchAllPatients();
    } catch (err) {
      const reason = err instanceof AnaCarePatientApiUnavailableError
        ? 'anacare_patient_api_unavailable'
        : `anacare_fetch_failed: ${err instanceof Error ? err.name : 'unknown'}`;
      return { ...base, records: [], expectedCount: null, readCount: 0, skipped: [], unmappedFields: [], fatalError: reason };
    }

    if (this.fieldMap.filter(m => m.active).length === 0) {
      return { ...base, records: [], expectedCount: page.expectedCount, readCount: 0, skipped: [], unmappedFields: [],
        fatalError: 'unmapped_source: source_field_map(ANACARE) vazio' };
    }

    const records: SourceRecord[] = [];
    const skipped: { externalId: string; reason: string }[] = [];
    const unmapped = new Set<string>();
    for (const rec of page.records) {
      const { canonical, unmappedFields } = fieldsToCanonical(rec.fields, this.fieldMap, this.country);
      unmappedFields.forEach(f => unmapped.add(f));
      if (!canonical.firstName && !canonical.lastName) {
        skipped.push({ externalId: rec.externalId, reason: 'no_name' });
        continue;
      }
      records.push({ externalId: rec.externalId, canonical });
    }

    return { ...base, records, expectedCount: page.expectedCount, readCount: records.length, skipped, unmappedFields: [...unmapped].sort() };
  }
}
