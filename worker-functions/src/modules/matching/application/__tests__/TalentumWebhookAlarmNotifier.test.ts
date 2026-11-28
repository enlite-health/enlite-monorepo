import type { PoolClient } from 'pg';
import { TalentumWebhookAlarmNotifier, TALENTUM_ALARM_REMINDER_MS } from '../TalentumWebhookAlarmNotifier';
import type { ITalentumAlarmStateRepository, TalentumAlarmState } from '../../infrastructure/TalentumAlarmStateRepository';
import type { TalentumWebhookHealth } from '@shared/events/TalentumWebhookHealthService';

const T0 = new Date('2026-11-25T12:00:00.000Z');
const HEALTH_0: TalentumWebhookHealth = { inbox_falha: 0, inbox_pendente: 0, veredito_ausente: 0, silencio: 0 };

/** Estado em memória, com a mesma semântica das 4 operações do repositório SQL. */
function memState() {
  const rows = new Map<string, TalentumAlarmState>();
  const repo: ITalentumAlarmStateRepository = {
    lock: async (_c, a) => rows.get(a) ?? null,
    open: async (_c, a, now, q) => {
      if (rows.has(a)) return false;
      rows.set(a, { abertoDesde: now, ultimoAvisoEm: now, quantidade: q });
      return true;
    },
    touch: async (_c, a, q, reminded) => {
      const r = rows.get(a)!;
      rows.set(a, { ...r, quantidade: q, ultimoAvisoEm: reminded ?? r.ultimoAvisoEm });
    },
    close: async (_c, a) => void rows.delete(a),
  };
  return { rows, repo };
}

function setup(opts: { publishFails?: boolean; uids?: string[]; withCell?: number } = {}) {
  const st = memState();
  const published: Array<{ recipientUids: readonly string[]; payload: { alarme: string; quantidade: number; desde: string } }> = [];
  const publisher = {
    publishTalentumWebhookAlarm: jest.fn(async (_c: PoolClient, input: (typeof published)[number]) => {
      if (opts.publishFails) throw new Error('insert falhou');
      published.push(input);
      return 'ev-1';
    }),
  };
  const recipients = { resolve: jest.fn(async () => ({ uids: opts.uids ?? ['coord-1', 'master-1'], withCell: opts.withCell ?? 1 })) };
  const warns: Array<Record<string, unknown>> = [];
  const client = { query: jest.fn(async () => ({ rows: [] })) };
  const n = new TalentumWebhookAlarmNotifier({
    publisher: publisher as never,
    recipients,
    state: st.repo,
    runInTx: (fn) => fn(client as never),
    log: { warn: (o) => void warns.push(o) },
  });
  return { n, st, published, publisher, warns, client };
}

describe('TalentumWebhookAlarmNotifier.notifyCycle — dedup por alarme (spec 095 §3.5, T15)', () => {
  it('2 ciclos seguidos com o alarme aberto → 1 aviso só (transição fechado→aberto); a quantidade é atualizada', async () => {
    const { n, published, st } = setup();
    await n.notifyCycle({ ...HEALTH_0, inbox_falha: 2 }, T0);
    await n.notifyCycle({ ...HEALTH_0, inbox_falha: 3 }, new Date(T0.getTime() + 5 * 60_000));
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({ recipientUids: ['coord-1', 'master-1'], payload: { alarme: 'inbox_falha', quantidade: 2, desde: T0.toISOString() } });
    expect(st.rows.get('inbox_falha')?.quantidade).toBe(3);
  });

  it('no dia seguinte (>= 24 h depois do último aviso) → 2º aviso, com `desde` = quando abriu; antes das 24 h, não', async () => {
    const { n, published } = setup();
    const aberto = { ...HEALTH_0, veredito_ausente: 1 };
    await n.notifyCycle(aberto, T0);
    await n.notifyCycle(aberto, new Date(T0.getTime() + TALENTUM_ALARM_REMINDER_MS - 1));
    expect(published).toHaveLength(1);
    await n.notifyCycle(aberto, new Date(T0.getTime() + TALENTUM_ALARM_REMINDER_MS));
    expect(published).toHaveLength(2);
    expect(published[1].payload).toMatchObject({ alarme: 'veredito_ausente', desde: T0.toISOString() });
    await n.notifyCycle(aberto, new Date(T0.getTime() + TALENTUM_ALARM_REMINDER_MS + 60_000)); // lembrete de agora conta de novo 24 h
    expect(published).toHaveLength(2);
  });

  it('contagem 0 → a linha é apagada; reabrir depois avisa de novo (transição)', async () => {
    const { n, published, st } = setup();
    await n.notifyCycle({ ...HEALTH_0, inbox_pendente: 4 }, T0);
    expect(st.rows.has('inbox_pendente')).toBe(true);
    await n.notifyCycle(HEALTH_0, new Date(T0.getTime() + 5 * 60_000));
    expect(st.rows.size).toBe(0);
    await n.notifyCycle({ ...HEALTH_0, inbox_pendente: 1 }, new Date(T0.getTime() + 10 * 60_000));
    expect(published).toHaveLength(2);
  });

  it('cada alarme tem o seu estado: um aberto não silencia o outro', async () => {
    const { n, published } = setup();
    await n.notifyCycle({ ...HEALTH_0, inbox_falha: 1 }, T0);
    await n.notifyCycle({ ...HEALTH_0, inbox_falha: 1, silencio: 1 }, new Date(T0.getTime() + 5 * 60_000));
    expect(published.map((p) => p.payload.alarme)).toEqual(['inbox_falha', 'silencio']);
  });

  it('publish falha → WARN sino_falhou (sem a mensagem do erro), o estado NÃO vira "avisado" (próximo ciclo tenta) e o ciclo não lança', async () => {
    const { n, warns, st } = setup({ publishFails: true });
    // o `runInTx` do teste não desfaz: simula o rollback que o `withActorContext` faz ao propagar o erro
    (n as unknown as { runInTx: unknown }).runInTx = async (fn: (c: PoolClient) => Promise<void>) => {
      const antes = new Map(st.rows);
      try { await fn({} as PoolClient); } catch (e) { st.rows.clear(); antes.forEach((v, k) => st.rows.set(k, v)); throw e; }
    };
    await expect(n.notifyCycle({ ...HEALTH_0, inbox_falha: 2 }, T0)).resolves.toBeUndefined();
    expect(warns).toContainEqual(expect.objectContaining({ msg: 'talentum_webhook_alarm', alarme: 'sino_falhou', origem: 'inbox_falha', quantidade: 2 }));
    expect(JSON.stringify(warns)).not.toContain('insert falhou');
    expect(st.rows.size).toBe(0);
  });

  it('sem coordenação com a célula → WARN sem_coordenacao (nunca silêncio) e o Master ainda recebe; sem NINGUÉM → sino_falhou', async () => {
    const a = setup({ withCell: 0, uids: ['master-1'] });
    await a.n.notifyCycle({ ...HEALTH_0, silencio: 1 }, T0);
    expect(a.warns).toContainEqual(expect.objectContaining({ alarme: 'sem_coordenacao' }));
    expect(a.published[0].recipientUids).toEqual(['master-1']);
    const b = setup({ withCell: 0, uids: [] });
    await b.n.notifyCycle({ ...HEALTH_0, silencio: 1 }, T0);
    expect(b.published).toHaveLength(0);
    expect(b.warns.map((w) => w.alarme)).toEqual(expect.arrayContaining(['sem_coordenacao', 'sino_falhou']));
  });
});

describe('TalentumWebhookAlarmNotifier.notify — CONFLITO_HUMANO (spec 095 §13.6)', () => {
  const conflict = { workerId: 'w-1', jobPostingId: 'jp-1', talentumPrescreeningId: 'tp-1' };

  it('um aviso por evento, sem dedup (2 conflitos → 2 avisos), payload só {alarme, quantidade 1, desde}, dentro de um SAVEPOINT liberado', async () => {
    const { n, published, client } = setup();
    await n.notify(client as never, conflict);
    await n.notify(client as never, conflict);
    expect(published).toHaveLength(2);
    expect(published[0].payload.alarme).toBe('CONFLITO_HUMANO');
    expect(published[0].payload.quantidade).toBe(1);
    expect(Object.keys(published[0].payload).sort()).toEqual(['alarme', 'desde', 'quantidade']);
    const sqls = client.query.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(sqls).toEqual(['SAVEPOINT talentum_conflito_sino', 'RELEASE SAVEPOINT talentum_conflito_sino', 'SAVEPOINT talentum_conflito_sino', 'RELEASE SAVEPOINT talentum_conflito_sino']);
  });

  it('a falha do sino NÃO lança: ROLLBACK TO SAVEPOINT, WARN sino_falhou, e a transação de quem chamou segue (o processamento não vira FAILED)', async () => {
    const { n, client, warns } = setup({ publishFails: true });
    await expect(n.notify(client as never, conflict)).resolves.toBeUndefined();
    const sqls = client.query.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(sqls).toEqual(['SAVEPOINT talentum_conflito_sino', 'ROLLBACK TO SAVEPOINT talentum_conflito_sino']);
    expect(warns).toContainEqual(expect.objectContaining({ msg: 'talentum_webhook_alarm', alarme: 'sino_falhou', origem: 'CONFLITO_HUMANO' }));
    expect(warns).toContainEqual({ msg: 'talentum_conflito_humano', ...conflict }); // o rastro por id continua, sem PII
  });
});
