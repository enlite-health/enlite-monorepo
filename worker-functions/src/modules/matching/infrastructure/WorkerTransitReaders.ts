/**
 * Adaptadores de banco das portas do "Cómo llegar" (spec 077 FR-46): `WorkerZoneReader` e `PatientItineraryPort`.
 * Cada leitura roda em `withActorContext` (conexão crua do pool cai na RLS de país, mesma régua do GetWorkerItineraryUseCase).
 * O itinerário é o do case (`readWorkerWindow`, dono do recorte do FR-44): infra → infra entre módulos, como o
 * `VertexAdmissionSummaryGenerator` (lê `@modules/case/infrastructure/TherapeuticCatalogRepository`).
 */
import type { PoolClient } from 'pg';
import { readWorkerWindow } from '@modules/case/infrastructure/WorkerItineraryReader';
import type { PatientItineraryItem, PatientItineraryPort, WorkerZoneLookup, WorkerZoneReader } from '../application/ports/WorkerTransitPorts';

export type RunInActorContext = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Zona viva com ponto, a mais recente (D659: o critério do /admin/mapa, `GetTransitCorridorUseCase`; 0,0 não é ponto).
 * D722: o rótulo da origem é SÓ o bairro (`neighborhood`); `address_line` (rua e número da prestadora) nunca é lido aqui.
 */
export const TRANSIT_ZONE_SQL =
  'SELECT neighborhood, latitude, longitude FROM worker_service_areas WHERE worker_id = $1 AND deleted_at IS NULL ' +
  'AND latitude IS NOT NULL AND longitude IS NOT NULL AND NOT (latitude = 0 AND longitude = 0) ORDER BY updated_at DESC LIMIT 1';

export class PgWorkerZoneReader implements WorkerZoneReader {
  constructor(private readonly run: RunInActorContext) {}

  findByAuthUid(authUid: string): Promise<WorkerZoneLookup> {
    return this.run(async (client) => {
      const w = (await client.query<{ id: string; status: string }>('SELECT id, status FROM workers WHERE auth_uid = $1 LIMIT 1', [authUid])).rows[0];
      if (!w) return { found: false };
      const z = (await client.query<{ neighborhood: string | null; latitude: string | number; longitude: string | number }>(TRANSIT_ZONE_SQL, [w.id])).rows[0];
      return {
        found: true,
        workerId: w.id,
        disabled: w.status === 'DISABLED',
        zone: z ? { label: z.neighborhood?.trim() ?? '', point: { lat: Number(z.latitude), lng: Number(z.longitude) } } : null,
      };
    });
  }
}

export class CaseItineraryAdapter implements PatientItineraryPort {
  constructor(
    private readonly run: RunInActorContext,
    private readonly read: typeof readWorkerWindow = readWorkerWindow,
  ) {}

  itemsOf(workerId: string, patientRef: string, today: string): Promise<PatientItineraryItem[]> {
    return this.run(async (client) => {
      const env = await this.read(client, { workerId, today });
      return env.items
        .filter((i) => i.patient_ref === patientRef)
        .map((i) => ({ hasAddress: i.address !== null, country: i.country, point: i.patient_point && { lat: i.patient_point.lat, lng: i.patient_point.lng } }));
    });
  }
}
