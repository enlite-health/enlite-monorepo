/** Dublê em memória da porta do informe (spec 092): sem banco, sem mock de módulo. Só para os unit dos use cases. */
import type { DailyReportPort, DailyReportTx, GuardOccurrence, ProjectVersionRef } from '../../ports/DailyReportPort';
import { DuplicateReportError } from '../../ports/DailyReportPort';
import type { ActivityRow, ObjectiveRow, ReportContent, Scale, ScaleCatalog } from '../../../domain/DailyReport';

const opt = (code: string, position: number, over: Partial<Scale['options'][number]> = {}): Scale['options'][number] =>
  ({ code, position, label: code, meaning: `significa ${code}`, score: null, alert: null, asksReason: false, ...over });

export const CATALOG: ScaleCatalog = new Map<string, Scale>([
  ['SN', { code: 'SN', name: 'Sí / No', answeredBy: 'AT', answerKind: 'SINGLE_CHOICE', options: [opt('si', 1), opt('no', 2)], reasons: [] }],
  ['AUT', {
    code: 'AUT', name: 'Desempeño', answeredBy: 'AT', answerKind: 'SINGLE_CHOICE',
    options: [opt('solo', 1), opt('no_lo_hizo', 2, { asksReason: true })],
    reasons: [{ code: 'rechazo', position: 1, label: 'Rechazo' }, { code: 'otro', position: 2, label: 'Otro' }],
  }],
  ['GEN', { code: 'GEN', name: 'Estado general', answeredBy: 'AT', answerKind: 'SINGLE_CHOICE', options: [opt('1', 1, { score: 1, alert: { kind: 'IMMEDIATE', text: 'avisa' } }), opt('2', 2, { score: 2 })], reasons: [] }],
  ['CNT', { code: 'CNT', name: 'Conteo', answeredBy: 'AT', answerKind: 'COUNT', options: [], reasons: [] }],
  ['OM', { code: 'OM', name: 'Opción múltiple', answeredBy: 'AT', answerKind: 'MULTI_CHOICE', options: [], reasons: [] }],
]);

export const SERVICE = 'serv-1';
export const OTHER_SERVICE = 'serv-2';
export const WORKER = 'worker-1';

export const obj = (id: string, scaleCode: string | null, question: string | null = scaleCode ? `¿${id}?` : null): ObjectiveRow =>
  ({ id, title: `título ${id}`, question, scaleCode });
export const act = (id: string, scaleCode: string | null): ActivityRow => ({ id, title: `título ${id}`, description: `desc ${id}`, scaleCode, frequency: 'Diaria' });

export const version = (id: string, over: Partial<ProjectVersionRef> = {}): ProjectVersionRef => ({
  id, contractedServiceId: SERVICE, startDate: '2026-09-01', endDate: '2026-12-31', createdAt: '2026-09-01T10:00:00.000Z', annulledAt: null,
  objectiveIds: ['o-aut', 'o-sn'], activityIds: ['a-sn', 'a-legado'], ...over,
});

export const guard = (over: Partial<GuardOccurrence> = {}): GuardOccurrence => ({
  occurrenceId: 'occ-1', slotId: 'slot-1', serviceId: SERVICE, onDate: '2026-11-16', endsAt: new Date('2026-11-16T15:00:00.000Z'), ...over,
});

export interface FakeState {
  worker: string | null;
  guards: GuardOccurrence[];
  versions: ProjectVersionRef[];
  objectives: ObjectiveRow[];
  activities: ActivityRow[];
  reports: Map<string, ReportContent>;
  raceOnInsert: boolean;
  inserted: Array<{ id: string; content: ReportContent }>;
}

export function fakeState(over: Partial<FakeState> = {}): FakeState {
  return {
    worker: WORKER, guards: [guard()], versions: [version('v1')],
    objectives: [obj('o-aut', 'AUT'), obj('o-sn', 'SN'), obj('o-legado', null), obj('o-om', 'OM')],
    activities: [act('a-sn', 'SN'), act('a-legado', null), act('a-om', 'OM')],
    reports: new Map(), raceOnInsert: false, inserted: [], ...over,
  };
}

export function fakePort(s: FakeState): DailyReportPort {
  const tx: DailyReportTx = {
    workerIdByUid: async () => s.worker,
    guardsOf: async () => s.guards,
    scaleCatalog: async () => CATALOG,
    projectVersionsOfService: async (serviceId) => s.versions.filter((v) => v.contractedServiceId === serviceId),
    projectVersionById: async (id) => s.versions.find((v) => v.id === id) ?? null,
    catalogItems: async (oIds, aIds) => ({
      objectives: s.objectives.filter((o) => oIds.includes(o.id)), activities: s.activities.filter((a) => aIds.includes(a.id)),
    }),
    reportById: async (id) => s.reports.get(id) ?? null,
    reportIdOfGuard: async (w, slot, date) =>
      [...s.reports].find(([, c]) => c.workerId === w && c.slotId === slot && c.onDate === date)?.[0] ?? null,
    insertReport: async (id, content) => {
      if (s.raceOnInsert) {
        s.raceOnInsert = false;
        s.reports.set(id, content);
        throw new DuplicateReportError();
      }
      s.reports.set(id, content);
      s.inserted.push({ id, content });
    },
  };
  return { run: (work) => work(tx) };
}
