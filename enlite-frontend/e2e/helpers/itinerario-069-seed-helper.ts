/**
 * itinerario-069-seed-helper.ts — cenários dos e2e de TELA da spec 069 (F7). A API só MONTA o cenário (paciente derivável, faixas, alocações,
 * candidatos); o que é provado (navegação, fluxo, desfazer…) passa pela tela. Reusa `seedDerivablePatient`/`selectedWorker`/`allocateWorker`.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { sqlComVars } from './sql-com-vars';
import { allocationOptionsApi, assembleApi } from './itinerario-escrita-e2e-helper';
import { readItineraryApi } from './itinerario-e2e-helper';
import {
  seedDerivablePatient, selectedWorker, allocateWorker, derivacaoToken, type DerivableSeed,
} from './derivacao-e2e-helper';

/** Faixas de 4 h às 08:00 de segunda, quarta e sexta (12 h/semana) — "titular com seg/qua/sex" da spec. */
export const SEG_QUA_SEX = [
  { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 },
  { dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 },
  { dayOfWeek: 5, startTime: '08:00', durationMinutes: 240 },
];

export interface Cenario {
  seed: DerivableSeed;
  patientId: string;
  serviceId: string;
  vacancyId: string;
  /** Faixas na ordem seg, qua, sex. */
  slotIds: string[];
  titular: string;
  /** Prestadores em Resposta Rápida da vaga (candidatos a cobrir). */
  sub: string;
  sub2: string;
  allocationIds: string[];
}

/** Um serviço seg/qua/sex, `providers_needed = 1`, o titular alocado nas 3 faixas e dois candidatos livres. */
export async function semearTitularSegQuaSex(request: APIRequestContext, opts: { alocar?: boolean } = {}): Promise<Cenario> {
  const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [{ schedule: SEG_QUA_SEX }] });
  try {
    const [svc] = seed.services;
    sqlComVars("UPDATE patient_contracted_services SET providers_needed = 1 WHERE id = :'id'::uuid", { id: svc.serviceId });
    const titular = selectedWorker(seed, svc.vacancyId);
    const sub = selectedWorker(seed, svc.vacancyId);
    const sub2 = selectedWorker(seed, svc.vacancyId);
    const allocationIds: string[] = [];
    if (opts.alocar !== false) {
      for (const slotId of svc.slotIds) {
        const r = await allocateWorker(request, seed.patientId, svc.serviceId, slotId, titular);
        expect(r.status, `alocar titular ${r.status} ${r.code ?? ''}`).toBe(201);
        allocationIds.push(r.allocationId as string);
      }
      // Montado ("Itinerario listo"): sem isso a derivação não move o estado do paciente (Activo ⇄ Búsqueda).
      const montar = await assembleApi(request, derivacaoToken(), seed.patientId);
      expect(montar.status, `montar ${montar.status}`).toBeLessThan(300);
    }
    return { seed, patientId: seed.patientId, serviceId: svc.serviceId, vacancyId: svc.vacancyId, slotIds: svc.slotIds, titular, sub, sub2, allocationIds };
  } catch (err) {
    seed.cleanup();
    throw err;
  }
}

/** O nome de tela de um prestador (o `displayName` que a API devolve nas opções de alocação do serviço). */
export async function nomeDe(request: APIRequestContext, patientId: string, serviceId: string, workerId: string): Promise<string> {
  const opts = await allocationOptionsApi(request, derivacaoToken(), patientId, serviceId);
  const found = ((opts.body.data as { options?: Array<{ workerId: string; displayName: string | null }> } | undefined)?.options ?? []).find((o) => o.workerId === workerId);
  if (found?.displayName) return found.displayName;
  const itin = await readItineraryApi(request, patientId);
  const dto = itin.body.data?.services.find((s) => s.contractedServiceId === serviceId);
  for (const slot of dto?.slots ?? []) {
    const a = (slot.assignments as unknown as Array<{ workerId: string; displayName?: string | null }>).find((x) => x.workerId === workerId);
    if (a?.displayName) return a.displayName;
  }
  throw new Error(`nomeDe: sem displayName para ${workerId}`);
}

/** O DTO do serviço lido da rota (oráculo para comparar com a tela). */
export async function servicoDaRota(request: APIRequestContext, patientId: string, serviceId: string): Promise<{
  cobertas: number; scheduleHours: number; uncoveredShifts: number; horizonDays: number; slots: Array<{ id: string; weekday: number; startTime: string; endTime: string }>;
}> {
  const itin = await readItineraryApi(request, patientId);
  expect(itin.status).toBe(200);
  const data = itin.body.data as unknown as { horizonDays: number; services: Array<Record<string, unknown>> };
  const s = data.services.find((x) => x.contractedServiceId === serviceId) as unknown as {
    cobertas: number; scheduleHours: number; uncoveredShifts: number; slots: Array<{ id: string; weekday: number; startTime: string; endTime: string }>;
  };
  return { cobertas: s.cobertas, scheduleHours: s.scheduleHours, uncoveredShifts: s.uncoveredShifts, horizonDays: data.horizonDays, slots: s.slots };
}
