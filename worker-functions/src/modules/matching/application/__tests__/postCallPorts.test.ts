/**
 * Portos do fim de call (spec 052, Fase 3, T-34a/b): a conformidade ESTRUTURAL dos repositórios da admissão (que não mudaram) e os
 * do enquadre com `PostCallSource`/`SubjectTrail` é conferida pelo compilador (ts-jest reprova o arquivo se quebrar); o resto é
 * comportamento dos repositórios do enquadre contra um banco falso que só captura SQL e parâmetros — sem banco, sem rede.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Pool } from 'pg';
import type { AdmissionPostCallRepository } from '../../infrastructure/AdmissionPostCallRepository';
import type { AdmissionImportRepository, ImportCandidate } from '../../infrastructure/AdmissionImportRepository';
import type { AdmissionEventRepository } from '../../infrastructure/AdmissionEventRepository';
import { EnquadrePostCallRepository } from '../../infrastructure/EnquadrePostCallRepository';
import { EnquadreEventTrailRepository } from '../../infrastructure/EnquadreEventTrailRepository';
import { ENQUADRE_POST_CALL_BATCH } from '../../domain/enquadreJobConfig';
import { AdmissionConferenceObserver } from '../AdmissionConferenceObserver';
import type { ImportSource } from '../ports/ImportPorts';
import type { PostCallDetectors, PostCallSource, SubjectTrail } from '../ports/PostCallPorts';
import type { MeetConferencePort } from '../ports/MeetConferencePort';
import type { AdmissionLogger } from '../AdmissionMessagingService';

// ── conformidade estrutural (compilador): a admissão usa os repositórios de sempre como fonte/destino ──
type AdmissionPostCallSide = PostCallSource & PostCallDetectors;
export const conformidade = {
  admissaoPostCall: null as unknown as AdmissionPostCallRepository satisfies AdmissionPostCallSide,
  admissaoImport: null as unknown as AdmissionImportRepository satisfies ImportSource<ImportCandidate>,
  admissaoTrilha: null as unknown as AdmissionEventRepository satisfies SubjectTrail,
  enquadrePostCall: null as unknown as EnquadrePostCallRepository satisfies PostCallSource,
  enquadreTrilha: null as unknown as EnquadreEventTrailRepository satisfies SubjectTrail,
};

type Call = { sql: string; params: unknown[] };
function fakeDb(): { db: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const db = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; } } as unknown as Pool;
  return { db, calls };
}
const NOW = new Date('2026-10-14T12:00:00Z');
/** O código do arquivo, sem comentários (a prosa pode citar `JOIN`; o SQL não). */
const ler = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('fonte do fim de call do enquadre (EnquadrePostCallRepository)', () => {
  it('o lote é o DO ENQUADRE (ENQUADRE_POST_CALL_BATCH), configurável no construtor, e um `limit` explícito vence', async () => {
    const a = fakeDb();
    await new EnquadrePostCallRepository(a.db).listCandidateIds(NOW);
    expect(a.calls[0].params).toEqual([NOW, ENQUADRE_POST_CALL_BATCH]);
    const b = fakeDb();
    await new EnquadrePostCallRepository(b.db, 7).listCandidateIds(NOW);
    expect(b.calls[0].params).toEqual([NOW, 7]);
    const c = fakeDb();
    await new EnquadrePostCallRepository(c.db, 7).listCandidateIds(NOW, 3);
    expect(c.calls[0].params).toEqual([NOW, 3]);
    expect(a.calls[0].sql).toMatch(/LIMIT \$2/);
  });

  it('trava por evento com FOR UPDATE ... SKIP LOCKED, sobre enquadre_events e SEM paciente (nem JOIN, nem tabela da admissão)', async () => {
    const { db, calls } = fakeDb();
    const repo = new EnquadrePostCallRepository(db);
    await repo.listCandidateIds(NOW);
    await repo.lockCandidate('e1', NOW, db);
    await repo.saveSpace('e1', 'spaces/x', db);
    await repo.markConferenceStarted('e1', NOW, NOW, db);
    await repo.markConferenceEnded('e1', NOW, NOW, db);
    await repo.markConferenceEndedEarly('e1', NOW, NOW, db);
    await repo.markBlocked('e1', db, 'meet_scope_missing');
    await repo.markNoShow('e1', db);
    expect(calls).toHaveLength(8);
    expect(calls[1].sql).toMatch(/FOR UPDATE OF e SKIP LOCKED/);
    for (const c of calls) {
      expect(c.sql).toMatch(/enquadre_events/); // controle positivo: a medição enxerga a tabela
      expect(c.sql).not.toMatch(/patients|admission_|JOIN/i);
    }
    // controle positivo do próprio verificador estático: o da admissão TEM `JOIN patients` e `admission_appointments`
    expect(ler('../../infrastructure/AdmissionPostCallRepository.ts')).toMatch(/JOIN patients[\s\S]*admission_appointments|admission_appointments[\s\S]*JOIN patients/);
    expect(ler('../../infrastructure/EnquadrePostCallRepository.ts')).not.toMatch(/JOIN|FROM patients|admission_appointments/);
  });

  it('o motivo do bloqueio vai para blocked_reason; o fim real e o no_show LIMPAM o motivo (o CHECK da 521 exige)', async () => {
    const { db, calls } = fakeDb();
    const repo = new EnquadrePostCallRepository(db);
    await repo.markBlocked('e1', db, 'no_meet_link');
    await repo.markBlocked('e2', db);
    await repo.markConferenceEnded('e1', NOW, NOW, db);
    await repo.markNoShow('e1', db);
    expect(calls[0].params).toEqual(['e1', 'no_meet_link']);
    expect(calls[1].params).toEqual(['e2', null]);
    expect(calls[2].sql).toMatch(/import_status = 'pending', blocked_reason = NULL/);
    expect(calls[3].sql).toMatch(/import_status = 'no_show', blocked_reason = NULL/);
    expect(calls[3].sql).not.toMatch(/SET status/); // o status do evento (open/closed) é da tela, não do job
  });
});

describe('trilha do enquadre (EnquadreEventTrailRepository)', () => {
  it('grava em enquadre_event_trail com o id do EVENTO e só os campos permitidos; ref vira JSON', async () => {
    const { db, calls } = fakeDb();
    await new EnquadreEventTrailRepository(db).append({ appointmentId: 'e1', kind: 'conference_ended', outcome: 'ended', reason: null, ref: { parts: 2 } });
    expect(calls[0].sql).toMatch(/INSERT INTO enquadre_event_trail \(event_id, kind, outcome, reason, ref, trace_id\)/);
    expect(calls[0].params.slice(0, 5)).toEqual(['e1', 'conference_ended', 'ended', null, '{"parts":2}']);
    expect(calls[0].sql).not.toMatch(/UPDATE|DELETE/);
  });
});

describe('observador do fim de call com nomes de log injetados', () => {
  const meet: MeetConferencePort = {
    resolveSpace: async () => ({ spaceName: 'spaces/x' }),
    listConferenceRecords: async () => [],
    listParticipants: async () => [],
  };
  const subject = {
    id: 'e1', host_email: 'h@example.test', meet_link: null, meet_space_name: 'spaces/x', slot_start: NOW, slot_end: NOW,
    conference_started_at: null, import_status: null, patient_is_test: false, rehearsal_until: null,
  };
  const repo = { saveSpace: async () => undefined, markConferenceStarted: async () => undefined, markConferenceEnded: async () => undefined, markConferenceEndedEarly: async () => undefined };
  const run = async (naming?: { prefix: string; idKey: string }) => {
    const logs: Array<[Record<string, unknown>, string]> = [];
    const log = { info: (o: Record<string, unknown>, m: string) => logs.push([o, m]), warn: () => undefined, error: () => undefined } as unknown as AdmissionLogger;
    const obs = new AdmissionConferenceObserver({ repo, meet, events: { append: async () => undefined }, log, ...(naming ? { naming } : {}) });
    await obs.recordEnd(subject, { endedAt: NOW, recordNames: ['conferenceRecords/a'] }, NOW, null as never);
    return logs;
  };

  it('sem `naming` = admissão (admission.conference_ended, appointmentId); com o do enquadre = enquadre.conference_ended, eventId', async () => {
    expect(await run()).toEqual([[{ appointmentId: 'e1', parts: 1 }, 'admission.conference_ended']]);
    expect(await run({ prefix: 'enquadre', idKey: 'eventId' })).toEqual([[{ eventId: 'e1', parts: 1 }, 'enquadre.conference_ended']]);
  });
});
