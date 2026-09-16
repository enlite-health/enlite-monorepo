/**
 * src/modules/anacare-hours/application/AnaCareHoursSyncGuard.ts
 *
 * F4 (tasks 4.8/4.9) — DESENHO mínimo do guard de concorrência exigido pelo "termina quando" da
 * fase-4.md: "disparo manual + cron ao mesmo tempo não dobra requests". Escopo estreito: só prova
 * o mecanismo de dedup (in-memory, uma instância de processo) — não é o job de produção (4.1-4.7,
 * bloqueado por F2/F3).
 *
 * Estratégia: enquanto uma rodada está em voo, qualquer chamada concorrente NÃO dispara uma nova
 * rodada — ela recebe o MESMO resultado da rodada em voo (compartilha a promise). Isso garante que
 * o número de chamadas à fonte (`AnaCareShiftsSource`) por disparo concorrente é sempre 1, nunca 2.
 */

export class AnaCareHoursSyncGuard<T> {
  private inFlight: Promise<T> | null = null;

  /**
   * Executa `fn` — mas se já existe uma rodada em voo, devolve o resultado DELA em vez de rodar
   * `fn` de novo. `deduped: true` sinaliza que esta chamada não disparou uma rodada própria.
   */
  async run(fn: () => Promise<T>): Promise<{ result: T; deduped: boolean }> {
    if (this.inFlight) {
      const result = await this.inFlight;
      return { result, deduped: true };
    }
    const promise = fn();
    this.inFlight = promise;
    try {
      const result = await promise;
      return { result, deduped: false };
    } finally {
      this.inFlight = null;
    }
  }
}
