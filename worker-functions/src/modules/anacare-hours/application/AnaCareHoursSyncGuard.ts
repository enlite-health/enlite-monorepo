/**
 * src/modules/anacare-hours/application/AnaCareHoursSyncGuard.ts
 *
 * F4 (tasks 4.8/4.9) — DESENHO mínimo do guard de concorrência exigido pelo "termina quando" da
 * fase-4.md: "disparo manual + cron ao mesmo tempo não dobra requests". Escopo estreito: só prova
 * o mecanismo de dedup (in-memory, uma instância de processo) — não é o job de produção (4.1-4.7,
 * bloqueado por F2/F3).
 *
 * Estratégia: enquanto uma rodada está em voo PARA UMA CHAVE, qualquer chamada concorrente PARA A
 * MESMA CHAVE não dispara uma nova rodada — ela recebe o MESMO resultado da rodada em voo
 * (compartilha a promise). Isso garante que o número de chamadas à fonte (`AnaCareShiftsSource`)
 * por disparo concorrente É POR CHAVE: sempre 1, nunca 2, dentro da mesma chave.
 *
 * Conserto (achado do gate `revisao-pr`, D398, change `anacare-horas-conclusao-de-corrida`): antes
 * o dedup era GLOBAL (um único `inFlight`, sem chave) — um disparo concorrente para um mês
 * DIFERENTE do que estava em voo herdava o resultado (status/cursor/contagens) do mês errado, e o
 * `AnaCareHoursSyncController` gravava isso em `anacare_sync_run` do mês que na verdade nunca
 * rodou. Chavear por mês restaura exatamente o "termina quando" original (manual+cron do MESMO mês
 * não dobram request) sem impedir que dois meses DIFERENTES rodem de verdade em paralelo — que é o
 * caso legítimo (staff sincroniza um mês antigo na tela enquanto o cron roda o mês corrente).
 */

export class AnaCareHoursSyncGuard<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * Executa `fn` — mas se já existe uma rodada em voo PARA A MESMA `key`, devolve o resultado DELA
   * em vez de rodar `fn` de novo. `deduped: true` sinaliza que esta chamada não disparou uma
   * rodada própria. Chamadas com `key` diferente NUNCA se juntam — cada uma dispara sua própria
   * rodada real, mesmo concorrente com outra em voo.
   */
  async run(key: string, fn: () => Promise<T>): Promise<{ result: T; deduped: boolean }> {
    const existing = this.inFlight.get(key);
    if (existing) {
      const result = await existing;
      return { result, deduped: true };
    }
    const promise = fn();
    this.inFlight.set(key, promise);
    try {
      const result = await promise;
      return { result, deduped: false };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
