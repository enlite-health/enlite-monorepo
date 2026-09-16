/**
 * AnaCarePatientApiReal — implementação real da porta `AnaCarePatientApi` (reconciliação,
 * F0/F3). Documento e agência só vêm pelo `patient` ANINHADO em `/api/shifts/` (F13 —
 * `/api/patients/` não traz documento) — por isso esta porta nunca chama `/api/patients/`:
 * itera os turnos crus já filtrados por agência (`iterateAgencyShiftsRaw`) e deduplica por
 * `patient.id`.
 */
import type { AnaCarePatientApi, AnaCarePatientPage, AnaCarePatientRecord } from '../../../reconciliation/domain/AnaCarePatientApi';
import type { AnaCareSessionClient } from './AnaCareSessionClient';
import { minimizePatientFields } from './AnaCareFieldMinimization';

export class AnaCarePatientApiReal implements AnaCarePatientApi {
  constructor(private readonly client: AnaCareSessionClient) {}

  async fetchAllPatients(): Promise<AnaCarePatientPage> {
    const byId = new Map<string, AnaCarePatientRecord>();

    for await (const page of this.client.iterateAgencyShiftsRaw()) {
      for (const raw of page) {
        const externalId = String(raw.patient.id);
        if (byId.has(externalId)) continue;
        byId.set(externalId, {
          externalId,
          fields: minimizePatientFields(raw.patient),
        });
      }
    }

    return {
      records: Array.from(byId.values()),
      // A API não declara um `count` de PACIENTES (só de turnos, por página) — não inventar.
      expectedCount: null,
    };
  }
}
