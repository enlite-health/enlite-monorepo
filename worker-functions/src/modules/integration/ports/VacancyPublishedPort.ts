/**
 * Porta de saída do publish no Talentum (semaforo-da-vaga F4): o que acontece com a vaga ao ser lançada (`is_draft = false`).
 * Quem implementa (o módulo de vagas) marca a pausa e cria o short link do feed; este módulo só conhece a porta.
 *
 *  - `markPauseInTx` (I1): DENTRO da transação do publish, depois do UPDATE — se o paciente da vaga já está pausado, a vaga nasce
 *    `PENDING_PAUSE` (o mesmo marcador do escritor de estado do paciente). Devolve os ids marcados.
 *  - `onPublished`: DEPOIS do commit — dispara a pausa dos ids marcados e cria o short link. Contrato: nunca rejeita; falha do
 *    lado de lá não desfaz o publish já commitado.
 */
export interface PublishTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface VacancyPublishedPort {
  markPauseInTx(tx: PublishTx, vacancyId: string): Promise<string[]>;
  onPublished(vacancyId: string, pausedVacancyIds: readonly string[]): Promise<void>;
}
