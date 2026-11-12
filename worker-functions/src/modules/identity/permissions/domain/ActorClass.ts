/**
 * C9 — a classe do ator de um grupo de permissão.
 *
 * `INTERNAL` é colaborador da Enlite. `EXTERNAL_THIRD_PARTY` é terceiro (plano
 * de saúde, parceiro) — e a diferença não é de nível de acesso: é de REGIME.
 * Acesso interno é tratamento próprio; entregar o mesmo dado a terceiro é
 * CESSÃO, que cai no art. 11.1 da Ley 25.326 e no art. 11 §4/§5 da LGPD.
 *
 * ⚠️ ESTA LISTA É A CÓPIA DE LEITURA. A verdade é o banco:
 * `iam.celulas_vedadas_a_terceiro()` + os dois triggers da migration 285 valem
 * para toda escrita, venha da tela, de um script de migração de dados ou de um
 * `psql` aberto num runbook. Aqui a lista existe para o PAINEL não oferecer o
 * que o banco vai recusar — negar depois de mostrar o checkbox é péssima UX e
 * faz o operador achar que o sistema está quebrado.
 *
 * Há teste de paridade: se as duas divergirem, ele acusa. Duas fontes que
 * divergem em silêncio é o D136, e já mordeu aqui antes.
 */

/**
 * `AGENT` (spec 078, M2, migration 556) é o grupo da IA: nome de pessoa artificial no ABAC. Só agente é
 * membro dele e ele nunca recebe `CELULAS_VEDADAS_A_AGENTE` (gestão de permissão, lote).
 */
export const ACTOR_CLASSES = ['INTERNAL', 'EXTERNAL_THIRD_PARTY', 'AGENT'] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

export const ACTOR_CLASS_PADRAO: ActorClass = 'INTERNAL';

/**
 * O que terceiro NUNCA recebe. Espelha `iam.celulas_vedadas_a_terceiro()`.
 * Mexer aqui sem mexer na migration (ou o contrário) quebra o teste de paridade.
 */
export const CELULAS_VEDADAS_A_TERCEIRO: ReadonlySet<string> = new Set([
  'worker_pii:read',
  'worker:export',
  'worker_document:read',
  'patient:read',
  'patient:write',
  'patient:delete',
]);

/**
 * O que grupo AGENT NUNCA recebe. Espelha `iam.celulas_vedadas_a_agente()` (migration 556) — mesmo teste de paridade.
 * ⚠️ O teste de paridade só prova que TS e SQL concordam; a prova de que a lista está CERTA é o e2e do item 36
 * (célula vedada de verdade em grupo AGENT de verdade → erro do banco).
 */
export const CELULAS_VEDADAS_A_AGENTE: ReadonlySet<string> = new Set([
  'permission_management:read',
  'permission_management:write',
  'worker:export',
]);

export function isActorClass(v: unknown): v is ActorClass {
  return typeof v === 'string' && (ACTOR_CLASSES as readonly string[]).includes(v);
}

/**
 * A célula pode ser concedida a um grupo desta classe?
 *
 * ⚠️ `INTERNAL` não é "pode tudo": é "esta regra não se aplica". Quem decide o
 * que o grupo interno recebe continua sendo a célula, e a revisão da C10/C12.
 */
export function podeConceder(classe: ActorClass, cellKey: string): boolean {
  if (classe === 'AGENT') return !CELULAS_VEDADAS_A_AGENTE.has(cellKey);
  if (classe !== 'EXTERNAL_THIRD_PARTY') return true;
  return !CELULAS_VEDADAS_A_TERCEIRO.has(cellKey);
}

/** As vedadas, para a tela explicar em vez de só desabilitar. */
export function motivoDaVedacao(classe: ActorClass, cellKey: string): string | null {
  if (podeConceder(classe, cellKey)) return null;
  if (classe === 'AGENT') {
    return `"${cellKey}" não pode ser concedida a um grupo de agente: gestão de permissão e operação em lote são só de pessoa (spec 078, item 36).`;
  }
  return (
    `"${cellKey}" não pode ser concedida a um grupo externo: entregar este dado a ` +
    `terceiro é cessão, e cessão tem regime próprio (Ley 25.326 art. 11.1; LGPD art. 11).`
  );
}
