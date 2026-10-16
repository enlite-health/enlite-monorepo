/**
 * spec 050, 4º passo, F24 (A24-4; R-46, R-47): a fila da janela ativa contra BANCO REAL (a consulta é SQL). Relógio fixo por parâmetro.
 * Reunião de 45 min. Cada cenário tem o controle do lado oposto na mesma execução (um "fora" só vale ao lado de um "dentro").
 */
import { Pool } from 'pg';
import { AdmissionLiveRepository } from '../../src/modules/matching/infrastructure/AdmissionLiveRepository';
import { LiveFixtures } from './helpers/admissionLiveFixtures';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const NOW = new Date('2026-10-12T15:00:00.000Z');
const H = 60;

describe('F24 — fila da janela ativa (AdmissionLiveRepository.listActiveIds)', () => {
  let admin: Pool;
  let fx: LiveFixtures;
  let repo: AdmissionLiveRepository;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    fx = new LiveFixtures(admin, 'f24fila', NOW);
    await fx.iniciar();
    repo = new AdmissionLiveRepository(admin);
  });
  afterAll(async () => {
    await fx.limpar();
    await admin.end();
  });

  const fila = async (): Promise<Set<string>> => new Set((await repo.listActiveIds(NOW, 500)).filter(Boolean));

  it('A24-4: antes, dentro e depois da janela → só a de dentro (e as bordas exatas: −15 min e +60 min)', async () => {
    const antes = await fx.semear({ inicioMin: 16, fimMin: 61 }); // entra em 16 min: 1 min fora
    const bordaAntes = await fx.semear({ inicioMin: 15, fimMin: 60 }); // −15 min exato: dentro
    const dentro = await fx.semear({ inicioMin: -10, fimMin: 35 });
    const bordaDepois = await fx.semear({ inicioMin: -105, fimMin: -60 }); // fim marcado + 60 min exato: dentro
    const depois = await fx.semear({ inicioMin: -106, fimMin: -61 }); // 1 min depois da borda
    const q = await fila();
    expect({ antes: q.has(antes), bordaAntes: q.has(bordaAntes), dentro: q.has(dentro), bordaDepois: q.has(bordaDepois), depois: q.has(depois) })
      .toEqual({ antes: false, bordaAntes: true, dentro: true, bordaDepois: true, depois: false });
  });

  it('A24-4: fora da janela com conferência ABERTA entra; sem conferência observada (controle) e aberta há mais de 72 h não entram', async () => {
    const estourou = await fx.semear({ inicioMin: -5 * H, fimMin: -4 * H - 15, conferenceStartedMin: -5 * H + 2 });
    const semConferencia = await fx.semear({ inicioMin: -5 * H, fimMin: -4 * H - 15 });
    const jaFechada = await fx.semear({ inicioMin: -5 * H, fimMin: -4 * H - 15, conferenceStartedMin: -5 * H + 2, conferenceEndedMin: -4 * H });
    const antigaDemais = await fx.semear({ inicioMin: -80 * H, fimMin: -79 * H, conferenceStartedMin: -80 * H + 2 });
    const q = await fila();
    expect({ estourou: q.has(estourou), semConferencia: q.has(semConferencia), jaFechada: q.has(jaFechada), antigaDemais: q.has(antigaDemais) })
      .toEqual({ estourou: true, semConferencia: false, jaFechada: false, antigaDemais: false });
  });

  it('A24-4: fora da janela com gatilho `armed` entra; fired, gave_up e cancelled (controles) não', async () => {
    const ids: Record<string, string> = {};
    for (const s of ['armed', 'fired', 'gave_up', 'cancelled'] as const) {
      ids[s] = await fx.semear({ inicioMin: -3 * H, fimMin: -2 * H - 15, conferenceStartedMin: -3 * H, conferenceEndedMin: -2 * H - 20, summaryFastState: s, importStatus: 'pending' });
    }
    const q = await fila();
    expect({ armed: q.has(ids.armed), fired: q.has(ids.fired), gave_up: q.has(ids.gave_up), cancelled: q.has(ids.cancelled) })
      .toEqual({ armed: true, fired: false, gave_up: false, cancelled: false });
  });

  it('A24-4: reunião cancelada, no_show e sem código ficam fora MESMO dentro da janela (controle: a mesma, booked com código, entra)', async () => {
    const ok = await fx.semear({ inicioMin: -5, fimMin: 40 });
    const cancelada = await fx.semear({ inicioMin: -5, fimMin: 40, status: 'cancelled' });
    const noShow = await fx.semear({ inicioMin: -5, fimMin: 40, status: 'no_show' });
    const semCodigo = await fx.semear({ inicioMin: -5, fimMin: 40, comCodigo: false });
    const q = await fila();
    expect({ ok: q.has(ok), cancelada: q.has(cancelada), noShow: q.has(noShow), semCodigo: q.has(semCodigo) })
      .toEqual({ ok: true, cancelada: false, noShow: false, semCodigo: false });
  });

  it('o limite da consulta vale (limit 1 devolve 1 id)', async () => {
    expect((await repo.listActiveIds(NOW, 1)).length).toBe(1);
  });
});
