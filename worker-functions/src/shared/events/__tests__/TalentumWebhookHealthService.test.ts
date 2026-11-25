import { TalentumWebhookHealthService } from '../TalentumWebhookHealthService';

const MIN = 60_000;
const H = 3_600_000;

interface InboxRow { state: string; received_at: Date }
interface MirrorRow { status: string; updated_at: Date }

/**
 * Pool falso que EXECUTA o predicado: filtra as linhas em memória pelos PARÂMETROS que o serviço manda
 * (estados/status e corte de tempo). Se o serviço passar IN_PROGRESS na lista de status, a linha entra na contagem.
 */
function fakePool(inbox: InboxRow[], mirror: MirrorRow[]) {
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    let n: number;
    if (sql.includes('talentum_prescreenings')) {
      const [status, cutoff] = params as [string[], Date];
      n = mirror.filter((r) => status.includes(r.status) && r.updated_at < cutoff).length;
    } else if (sql.includes('state = ANY($1')) {
      const [states] = params as [string[]];
      n = inbox.filter((r) => states.includes(r.state)).length;
    } else if (sql.includes('state = $1')) {
      const [state, cutoff] = params as [string, Date];
      n = inbox.filter((r) => r.state === state && r.received_at < cutoff).length;
    } else {
      const [since] = params as [Date];
      n = inbox.filter((r) => r.received_at >= since).length;
    }
    return { rows: [{ n }] };
  });
  return { query };
}

// Instantes UTC explícitos (AR = UTC-3, sem DST): independem do TZ do processo.
const AR_15H = new Date('2026-11-25T18:00:00Z');
const AR_08H = new Date('2026-11-25T11:00:00Z');

const health = (now: Date, inbox: InboxRow[] = [], mirror: MirrorRow[] = []) =>
  new TalentumWebhookHealthService(fakePool(inbox, mirror) as never).getHealth(now);

describe('TalentumWebhookHealthService (spec 095 T-095-40)', () => {
  it('COMPLETED há 2 h 1 min → veredito_ausente; há 1 h 59 min → nada', async () => {
    const velho = [{ status: 'COMPLETED', updated_at: new Date(AR_15H.getTime() - (2 * H + MIN)) }];
    const novo = [{ status: 'COMPLETED', updated_at: new Date(AR_15H.getTime() - (2 * H - MIN)) }];
    const inbox = [{ state: 'PROCESSED', received_at: AR_15H }];
    expect((await health(AR_15H, inbox, velho)).veredito_ausente).toBe(1);
    expect((await health(AR_15H, inbox, novo)).veredito_ausente).toBe(0);
  });

  it('IN_PROGRESS há 30 dias → nada (abandono nunca alarma)', async () => {
    const mirror = [{ status: 'IN_PROGRESS', updated_at: new Date(AR_15H.getTime() - 30 * 24 * H) }];
    const h = await health(AR_15H, [{ state: 'PROCESSED', received_at: AR_15H }], mirror);
    expect(h).toEqual({ inbox_falha: 0, inbox_pendente: 0, veredito_ausente: 0, silencio: 0 });
  });

  it('RECEIVED há 16 min → inbox_pendente; há 14 min → nada', async () => {
    const h16 = await health(AR_15H, [{ state: 'RECEIVED', received_at: new Date(AR_15H.getTime() - 16 * MIN) }]);
    const h14 = await health(AR_15H, [{ state: 'RECEIVED', received_at: new Date(AR_15H.getTime() - 14 * MIN) }]);
    expect(h16.inbox_pendente).toBe(1);
    expect(h14.inbox_pendente).toBe(0);
  });

  it('FAILED / REJECTED_SCHEMA / UNSUPPORTED → inbox_falha; PROCESSED e RECEIVED não', async () => {
    const t = AR_15H;
    const inbox = ['FAILED', 'REJECTED_SCHEMA', 'UNSUPPORTED', 'PROCESSED', 'RECEIVED'].map((state) => ({ state, received_at: t }));
    expect((await health(AR_15H, inbox)).inbox_falha).toBe(3);
  });

  it('0 linhas na inbox às 08:00 AR → nada; às 15:00 AR → silencio', async () => {
    expect((await health(AR_08H)).silencio).toBe(0);
    expect((await health(AR_15H)).silencio).toBe(1);
  });

  it('silêncio: linha recente (< 6 h) às 15:00 AR → nada; borda 09:00 conta, 21:00 não', async () => {
    const recente = [{ state: 'PROCESSED', received_at: new Date(AR_15H.getTime() - 5 * H) }];
    expect((await health(AR_15H, recente)).silencio).toBe(0);
    expect((await health(new Date('2026-11-25T12:00:00Z'))).silencio).toBe(1); // 09:00 AR
    expect((await health(new Date('2026-11-25T23:59:00Z'))).silencio).toBe(1); // 20:59 AR
    expect((await health(new Date('2026-11-26T00:00:00Z'))).silencio).toBe(0); // 21:00 AR
  });
});
