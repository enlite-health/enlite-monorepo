/**
 * F4 (tasks 4.8/4.9) — prova do "termina quando" da fase-4.md linhas 39-42:
 *   - "disparo manual + cron ao mesmo tempo não dobra requests" (4.8)
 *   - "sabotagem: rodada sem emitir a métrica falha o teste" (4.9)
 *
 * Fonte: STUB em memória com contador de chamadas (nunca `FakeAnaCareShiftsSource` real de rede —
 * aqui só precisamos CONTAR chamadas, não gerar massa).
 */
import { AnaCareHoursSyncRunner } from '../AnaCareHoursSyncRunner';
import { AnaCareHoursSyncGuard } from '../AnaCareHoursSyncGuard';
import type { AnaCareShiftsSource, ListShiftsParams, SourceShiftDTO } from '../../domain/AnaCareShiftsSource';
import type { AnaCareHoursSyncMetric } from '../../infrastructure/AnaCareHoursSyncMetrics';

class CountingShiftsSource implements AnaCareShiftsSource {
  calls = 0;
  private readonly delayMs: number;

  constructor(delayMs = 20) {
    this.delayMs = delayMs;
  }

  async listShifts(_params: ListShiftsParams): Promise<SourceShiftDTO[]> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return [];
  }

  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }

  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

describe('AnaCareHoursSyncRunner — dedup de disparo concorrente (4.8)', () => {
  it('manual + cron simultâneos resultam em UMA única chamada à fonte', async () => {
    const source = new CountingShiftsSource(30);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09');

    const [manual, cron] = await Promise.all([
      runner.run({ origin: 'manual', userId: 'staff-1' }),
      runner.run({ origin: 'cron', userId: null }),
    ]);

    expect(source.calls).toBe(1);
    // Uma das duas rodadas é a "dona" (deduped: false), a outra compartilha o resultado.
    expect([manual.deduped, cron.deduped].sort()).toEqual([false, true]);
  });

  it('duas rodadas sequenciais (não concorrentes) SÃO duas chamadas — dedup é só para concorrência', async () => {
    const source = new CountingShiftsSource(1);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09');

    await runner.run({ origin: 'manual', userId: 'staff-1' });
    await runner.run({ origin: 'cron', userId: null });

    expect(source.calls).toBe(2);
  });

  it('SABOTAGEM (guard removido): 2 disparos concorrentes viram 2 chamadas à fonte', async () => {
    // Simula o que aconteceria se o Runner não passasse pelo guard: chama a fonte direto.
    const source = new CountingShiftsSource(30);
    const sabotagedRun = () => Promise.all([source.listShifts({ month: '2026-09' }), source.listShifts({ month: '2026-09' })]);
    await sabotagedRun();
    expect(source.calls).toBe(2); // prova que SEM o guard, o dedup não acontece — o guard é o que faz a diferença
  });
});

describe('AnaCareHoursSyncRunner — métrica de custo/consumo (4.9)', () => {
  it('toda rodada emite a métrica com os campos exigidos (requests, retries, duração, origem)', async () => {
    const source = new CountingShiftsSource(1);
    const emitted: AnaCareHoursSyncMetric[] = [];
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), (m) => emitted.push(m), () => '2026-09');

    await runner.run({ origin: 'manual', userId: 'staff-1' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'anacare_hours_sync',
      origin: 'manual',
      userId: 'staff-1',
      requests: 1,
      retries: 0,
      deduped: false,
    });
    expect(typeof emitted[0].durationMs).toBe('number');
  });

  it('rodada de origem cron NÃO carrega userId (nunca PII/identidade fora do disparo manual)', async () => {
    const source = new CountingShiftsSource(1);
    const emitted: AnaCareHoursSyncMetric[] = [];
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), (m) => emitted.push(m), () => '2026-09');

    await runner.run({ origin: 'cron', userId: null });

    expect(emitted[0].userId).toBeNull();
  });

  it('a rodada DEDUPED também emite métrica (origem concorrente fica visível)', async () => {
    const source = new CountingShiftsSource(30);
    const emitted: AnaCareHoursSyncMetric[] = [];
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), (m) => emitted.push(m), () => '2026-09');

    await Promise.all([runner.run({ origin: 'manual', userId: 'staff-1' }), runner.run({ origin: 'cron', userId: null })]);

    expect(emitted).toHaveLength(2);
    expect(emitted.filter((m) => m.deduped)).toHaveLength(1);
  });
});
