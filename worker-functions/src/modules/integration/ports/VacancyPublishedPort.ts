/**
 * Porta de saída do publish no Talentum (semaforo-da-vaga F4): o que acontece com a vaga DEPOIS do commit que a lança
 * (`is_draft = false`). Quem implementa (o módulo de vagas) cria o short link do feed; este módulo só conhece a porta.
 * Contrato: nunca rejeita — falha do lado de lá não desfaz o publish já commitado.
 */
export interface VacancyPublishedPort {
  onPublished(vacancyId: string): Promise<void>;
}
