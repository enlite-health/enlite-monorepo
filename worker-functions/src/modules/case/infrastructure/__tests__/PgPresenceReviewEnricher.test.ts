import type { Pool } from 'pg';
import { PgPresenceReviewEnricher } from '../PgPresenceReviewEnricher';
import type { ShiftDirectory, ShiftFacts } from '../../application/ports/CoordinationAlertPorts';
import type { ReviewQueueEntry } from '../../application/ports/PresenceReviewPorts';

const queries: Array<{ sql: string; params: unknown[] }> = [];
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: { query: (sql: string, params: unknown[]) => unknown }) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM workers')) return { rows: [{ id: 'w1', first_name_encrypted: 'enc:Fulana', last_name_encrypted: 'enc:Tal' }, { id: 'w2', first_name_encrypted: '', last_name_encrypted: '' }] };
        return { rows: [{ id: 'p1', case_number: '1234' }] };
      },
    }),
}));

const enc = { decrypt: async (s: string) => (s.startsWith('enc:') ? s.slice(4) : '') } as never;
const entry = (over: Partial<ReviewQueueEntry>): ReviewQueueEntry => ({
  kind: 'EXCEPTION_PENDING', id: 'e1', occurrenceId: 'o1', workerId: 'w1', slotId: 's1', onDate: '2026-11-25', occurredAt: '2026-11-25T14:00:00.000Z', reason: null, exceptionKind: null, distanceM: null, accuracyM: null, ...over,
});
const shift = (over: Partial<ShiftFacts>): ShiftFacts => ({ occurrenceId: 'o1', slotId: 's1', onDate: '2026-11-25', workerId: 'w1', serviceId: 'sv', patientId: 'p1', country: 'AR', startsAt: '', endsAt: '', startTime: '08:00', endTime: '16:00', isTest: false, ...over });

describe('PgPresenceReviewEnricher (emenda 077 §6)', () => {
  beforeEach(() => { queries.length = 0; });

  it('resolve nome (KMS), nº do caso e horário; uma chamada do itinerário por janela; entrada recusada (sem on_date) usa o dia da recusa ± 1', async () => {
    const resolve = jest.fn().mockImplementation(async (c: Array<{ occurrenceId: string }>) => new Map(c.filter((x) => x.occurrenceId === 'o1').map((x) => [x.occurrenceId, shift({})])));
    const shifts: ShiftDirectory = { resolve };
    const items = [entry({}), entry({ kind: 'ENTRY_REFUSED_NO_ENTRY', id: 'o9', occurrenceId: 'o9', workerId: 'w2', slotId: null, onDate: null, occurredAt: '2026-11-25T01:00:00.000Z' })];
    const out = await new PgPresenceReviewEnricher(shifts, {} as Pool, enc).enrich(items);
    expect(resolve).toHaveBeenCalledWith([{ occurrenceId: 'o1', workerId: 'w1' }], { from: '2026-11-25', to: '2026-11-25' });
    expect(resolve).toHaveBeenCalledWith([{ occurrenceId: 'o9', workerId: 'w2' }], { from: '2026-11-24', to: '2026-11-26' });
    expect(out.get('EXCEPTION_PENDING:e1')).toEqual({ workerName: 'Fulana Tal', caseNumber: 1234, startTime: '08:00', endTime: '16:00', onDate: '2026-11-25' });
    // turno que saiu do itinerário e prestador sem nome: o item continua, sem horário nem caso
    expect(out.get('ENTRY_REFUSED_NO_ENTRY:o9')).toEqual({ workerName: null, caseNumber: null, startTime: null, endTime: null, onDate: null });
  });

  it('nome só é lido do banco para os prestadores da página (sem duplicata) e o caso só para os pacientes achados', async () => {
    const shifts: ShiftDirectory = { resolve: async () => new Map() };
    await new PgPresenceReviewEnricher(shifts, {} as Pool, enc).enrich([entry({ id: 'a' }), entry({ id: 'b', occurrenceId: 'o2' })]);
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual([['w1']]);
  });
});
