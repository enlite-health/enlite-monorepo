/**
 * anacare-mirror-health.e2e.test.ts
 *
 * E2E de AnaCareMirrorHealthService contra Postgres REAL (enlite_e2e).
 *
 * POR QUE ESTE ARQUIVO EXISTE:
 * o serviço é 100% uma query SQL, e até 18/08/2026 a única cobertura eram o
 * helper puro (`anaCareMirrorHealthMath`) e um controller com o serviço
 * MOCKADO — ou seja, a query nunca era executada em teste. Foi assim que o
 * relógio errado (`workers.created_at` em vez do instante em que o worker
 * virou REGISTERED) chegou em produção e paginou 2x num dia com o espelho são,
 * enquanto escondia caso real no balde `chronicTotal`.
 *
 * Cada caso abaixo separa as duas datas de propósito: com o relógio antigo,
 * A e B dão a resposta ERRADA.
 */

import { Pool } from 'pg';
import { AnaCareMirrorHealthService } from '@shared/events/AnaCareMirrorHealthService';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STUCK_THRESHOLD_HOURS = 2;
const RECENCY_WINDOW_HOURS = 168;

interface SeedOptions {
  key: string;
  /** Idade da LINHA do worker (o que o relógio antigo usava). */
  createdAgoHours: number;
  /** Quando virou REGISTERED. `null` = sem história (importação em massa). */
  registeredAgoHours: number | null;
  anaCareId?: number;
}

describe('AnaCareMirrorHealthService — o relógio começa em REGISTERED', () => {
  let pool: Pool;
  let service: AnaCareMirrorHealthService;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new AnaCareMirrorHealthService(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE 'e2e-mirror-health-%'`);
    await pool.end();
  });

  /**
   * Os casos abaixo afirmam contagens EXATAS (`toBe(1)`), porque o serviço conta a
   * tabela inteira — não só o que este arquivo semeou. Isso hoje se sustenta pelo
   * TRUNCATE de `tests/e2e/setup.ts`, mas isso é garantia ACIDENTAL: qualquer
   * escrita concorrente no `enlite_e2e` (o container da API vive no mesmo banco)
   * derrubaria os asserts com uma mensagem que não explica nada.
   *
   * Então a precondição vira explícita: se o conjunto elegível não estiver zerado
   * depois da limpeza, o teste falha AQUI, dizendo o porquê.
   */
  beforeEach(async () => {
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE 'e2e-mirror-health-%'`);

    const baseline = await service.getMirrorHealth(STUCK_THRESHOLD_HOURS, RECENCY_WINDOW_HOURS);
    if (baseline.stuckRecent !== 0 || baseline.chronicTotal !== 0) {
      throw new Error(
        `Banco de teste sujo: havia ${baseline.stuckRecent} preso(s) recente(s) e ` +
          `${baseline.chronicTotal} crônico(s) ANTES de semear. Os asserts deste arquivo ` +
          `são contagens absolutas e só valem com o conjunto elegível zerado.`,
      );
    }
  });

  async function seed(opts: SeedOptions): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, ana_care_id,
                            first_name_encrypted, last_name_encrypted, sex_encrypted,
                            created_at)
       VALUES ($1, $2, 'REGISTERED', 'AR', $3, 'enc-fn', 'enc-ln', 'enc-sex',
               NOW() - make_interval(mins => $4::int))
       RETURNING id`,
      [
        `e2e-mirror-health-${opts.key}`,
        `e2e-mirror-health-${opts.key}@example.com`,
        opts.anaCareId ?? null,
        Math.round(opts.createdAgoHours * 60),
      ],
    );
    const id = rows[0].id;

    if (opts.registeredAgoHours !== null) {
      await pool.query(
        `INSERT INTO worker_status_history
           (worker_id, field_name, old_value, new_value, change_source, created_at)
         VALUES ($1, 'status', 'INCOMPLETE_REGISTER', 'REGISTERED', 'e2e',
                 NOW() - make_interval(mins => $2::int))`,
        [id, Math.round(opts.registeredAgoHours * 60)],
      );
    }
    return id;
  }

  const health = () => service.getMirrorHealth(STUCK_THRESHOLD_HOURS, RECENCY_WINDOW_HOURS);

  it('A) NÃO pagina quem acabou de virar REGISTERED, por mais velho que seja o cadastro', async () => {
    // Caso real de 18/08: cadastro de 11/08 (148h), registro concluído 5min atrás,
    // espelho fecharia normal em ~10min. O relógio antigo dizia "preso há 148h".
    await seed({ key: 'a-recem-registered', createdAgoHours: 148, registeredAgoHours: 0.08 });

    const result = await health();

    expect(result.stuckRecent).toBe(0);
    expect(result.stuck).toBe(false);
    expect(result.chronicTotal).toBe(0);
  });

  it('B) PAGINA quem virou REGISTERED dentro da janela, mesmo com cadastro antigo (o ponto cego)', async () => {
    // Cadastro de 288h atrás (> janela de recência): o relógio antigo jogava
    // direto em chronicTotal, que por desenho NÃO pagina — falha nova ficava muda.
    await seed({ key: 'b-cego', createdAgoHours: 288, registeredAgoHours: 72 });

    const result = await health();

    expect(result.stuckRecent).toBe(1);
    expect(result.stuck).toBe(true);
    expect(result.chronicTotal).toBe(0);
    // A idade é medida da ELEGIBILIDADE (72h), não da criação da linha (288h).
    expect(result.oldestStuckAgeHours).toBeGreaterThan(71);
    expect(result.oldestStuckAgeHours).toBeLessThan(73);
  });

  it('C) segue paginando o caso simples: virou REGISTERED há 4h e não espelhou', async () => {
    await seed({ key: 'c-simples', createdAgoHours: 5, registeredAgoHours: 4 });

    const result = await health();

    expect(result.stuckRecent).toBe(1);
    expect(result.stuck).toBe(true);
  });

  it('D) sem história de status, cai no created_at (linhas de importação em massa)', async () => {
    await seed({ key: 'd-sem-historia', createdAgoHours: 300, registeredAgoHours: null });

    const result = await health();

    expect(result.stuckRecent).toBe(0);
    expect(result.chronicTotal).toBe(1);
  });

  it('E) quem já tem ana_care_id não entra em conta nenhuma', async () => {
    await seed({ key: 'e-espelhado', createdAgoHours: 288, registeredAgoHours: 72, anaCareId: 99001 });

    const result = await health();

    expect(result.stuckRecent).toBe(0);
    expect(result.chronicTotal).toBe(0);
    expect(result.stuck).toBe(false);
  });

  it('G) na oscilação, vale a ÚLTIMA vez que virou REGISTERED, não a primeira', async () => {
    // Sem este caso, trocar MAX por MIN na subconsulta mantém todos os outros verdes —
    // e o relógio passaria a medir de uma elegibilidade que já foi revogada.
    // Cenário: registrou há 100h, foi desativado, e voltou a registrar há 1h.
    const id = await seed({ key: 'g-oscilacao', createdAgoHours: 400, registeredAgoHours: 100 });
    await pool.query(
      `INSERT INTO worker_status_history
         (worker_id, field_name, old_value, new_value, change_source, created_at)
       VALUES ($1, 'status', 'REGISTERED', 'DISABLED', 'e2e', NOW() - make_interval(mins => 3000)),
              ($1, 'status', 'DISABLED', 'REGISTERED', 'e2e', NOW() - make_interval(mins => 60))`,
      [id],
    );

    const result = await health();

    // Com MAX (correto): elegível há 1h → nem preso (< 2h) nem crônico.
    // Com MIN: elegível há 100h → apareceria como preso recente.
    expect(result.stuckRecent).toBe(0);
    expect(result.chronicTotal).toBe(0);
    expect(result.stuck).toBe(false);
  });

  it('F) recente e crônico convivem sem se contaminar', async () => {
    await seed({ key: 'f-recente', createdAgoHours: 288, registeredAgoHours: 72 });
    await seed({ key: 'f-cronico', createdAgoHours: 900, registeredAgoHours: 800 });
    await seed({ key: 'f-novinho', createdAgoHours: 148, registeredAgoHours: 0.08 });

    const result = await health();

    expect(result.stuckRecent).toBe(1);
    expect(result.chronicTotal).toBe(1);
    expect(result.stuck).toBe(true);
  });
});
