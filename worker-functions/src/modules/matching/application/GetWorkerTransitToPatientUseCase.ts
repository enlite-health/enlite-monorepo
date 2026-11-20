/**
 * GetWorkerTransitToPatientUseCase — `GET /api/workers/me/patients/:patientRef/transit` (spec 077 FR-46, D659, PA-02).
 *
 * "Cómo llegar" da cuidadora: o transporte público da ZONA dela (área de serviço viva mais recente, como no /admin/mapa)
 * até o paciente; nunca o GPS. Só portas (`./ports/WorkerTransitPorts`) e domínio (`transitRoute`): banco, transação e
 * Google são dos adaptadores, montados em `../infrastructure/workerTransitComposition`. O envio ao Google é o da D264-b.
 *
 * Ordem (custo de API ≈ 0, PA-02 A3): prestador → zona → itinerário; o Google é chamado no máximo 1 vez, e só no fim:
 *   - prestador inexistente ou DISABLED → ACCOUNT_INACTIVE;
 *   - sem zona viva com ponto → NO_SERVICE_AREA, ANTES de ler o itinerário (o app mostra "cargá tu zona");
 *   - o destino só existe se o itinerário dela (o Reader do case, dono do recorte do FR-44) tiver, para esse `patient_ref`,
 *     um item com endereço (ocorrência em [hoje, hoje+7] da alocação ACTIVE); senão ADDRESS_NOT_AVAILABLE;
 *   - item de paciente fora de AR (`patients.country`, CHECK AR|BR) → ADDRESS_NOT_AVAILABLE: só AR está coberto pelo
 *     parecer do `lex` de 14/11 (condição B3; BR = LGPD art. 33);
 *   - item sem ponto (paciente sem lat/lng) → 200 sem rotas.
 * O destino enviado é o ponto do item (grade de ~20 m), não a coordenada real. A resposta leva só `origin_label` e as
 * pernas de transporte (linha, de, até): nenhuma polilinha, cor, metro ou coordenada. Log: 1 linha `transit.me` por chamada
 * com `outcome` e `google_calls` (0|1 = a requisição SAIU, `TransitPort.transitCall().called`), sem uid, ref, endereço nem
 * coordenada; o `traceId` entra pelo logger.
 */
import { logger } from '@shared/logging';
import { buildTransitRoutes, type RouteLeg, type TransitRoute } from '../domain/transitRoute';
import type { PatientItineraryPort, TransitPoint, TransitPort, WorkerZoneReader } from './ports/WorkerTransitPorts';

export interface WorkerTransitRoute {
  mode: string;
  duration_min: number;
  steps: Array<{ line: string; from: string; to: string }>;
}

type FailCode = 'ACCOUNT_INACTIVE' | 'NO_SERVICE_AREA' | 'ADDRESS_NOT_AVAILABLE';

export type WorkerTransitResult = { ok: true; origin_label: string; routes: WorkerTransitRoute[] } | { ok: false; code: FailCode };

type TransitLeg = Extract<RouteLeg, { kind: 'transit' }>;

/** Só o que a tela mostra: o veículo da 1ª perna de transporte, os minutos e as pernas de transporte (linha, de, até). */
function toWire(r: TransitRoute): WorkerTransitRoute {
  const transit = r.legs.filter((l): l is TransitLeg => l.kind === 'transit');
  return { mode: transit[0].mode, duration_min: r.totalMinutes, steps: transit.map((l) => ({ line: l.line, from: l.from, to: l.to })) };
}

export class GetWorkerTransitToPatientUseCase {
  constructor(
    private readonly workers: WorkerZoneReader,
    private readonly itinerary: PatientItineraryPort,
    private readonly transit: TransitPort,
  ) {}

  async execute(authUid: string, patientRef: string, today: string): Promise<WorkerTransitResult> {
    const fail = (code: FailCode): WorkerTransitResult => {
      logger.info({ msg: 'transit.me', outcome: code, google_calls: 0 });
      return { ok: false, code };
    };
    const worker = await this.workers.findByAuthUid(authUid);
    if (!worker.found || worker.disabled) return fail('ACCOUNT_INACTIVE');
    const zone = worker.zone;
    if (!zone) return fail('NO_SERVICE_AREA');
    const item = (await this.itinerary.itemsOf(worker.workerId, patientRef, today)).find((i) => i.hasAddress);
    if (!item) return fail('ADDRESS_NOT_AVAILABLE');
    if (item.country !== 'AR') return fail('ADDRESS_NOT_AVAILABLE');
    const destination: TransitPoint | null = item.point;
    if (!destination) {
      logger.info({ msg: 'transit.me', outcome: 'NO_POINT', google_calls: 0 });
      return { ok: true, origin_label: zone.label, routes: [] };
    }
    const call = await this.transit.transitCall(zone.point, destination);
    const built = buildTransitRoutes(call.routes);
    logger.info({ msg: 'transit.me', outcome: built.outcome, google_calls: call.called ? 1 : 0 });
    return { ok: true, origin_label: zone.label, routes: built.routes.map(toWire) };
  }
}
