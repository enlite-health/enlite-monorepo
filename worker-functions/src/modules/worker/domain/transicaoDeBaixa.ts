/**
 * C7 e C8 — a baixa de conta do prestador é uma transição com regra própria.
 *
 * ── C7: por que uma célula só para isto ─────────────────────────────────────
 * Dar e reverter baixa é a operação mais destrutiva sobre a conta de uma pessoa,
 * e estava sob `worker:write` — a mesma célula de corrigir uma ocupação digitada
 * errado. Quem podia arrumar um typo podia apagar alguém da operação.
 *
 * A célula é `worker:disable` e cobre **as duas direções**. ⚠️ Fraqueza assumida
 * na D168: o nome soa unidirecional. Resolver na descrição e no rótulo da tela
 * ("Dar e reverter baixa"), **nunca** com uma segunda célula — partir operação
 * rara em duas só aumenta a chance de conceder metade.
 *
 * ── C8: o que célula nenhuma destrava ───────────────────────────────────────
 * Se a baixa foi pedida pelo TITULAR (a Luz executa `deactivate_account`, e o
 * trigger grava `changed_by = 'worker_self:<uid>'`, D95), nenhuma célula de
 * staff a reverte. Não é questão de nível de acesso: é que a manifestação de
 * vontade da pessoa não é um estado que o operador administra. Reverter exige
 * novo pedido dela — e aí o autor da reversão é ela, não o staff.
 *
 * Sem isto, `worker:disable` viraria a permissão de cancelar o opt-out alheio,
 * e o opt-out é justamente o que impede o contato (25.326 art. 27.3; LGPD
 * art. 18 IV).
 */

export type WorkerStatus = 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED';

/**
 * ⚠️ CÓPIA CONSCIENTE da chave canônica (`CELL_WORKER_DISABLE` no barrel
 * `@modules/identity/permissions`), e não descuido — o gate `revisao-pr`
 * levantou a duplicação (B5) e esta é a justificativa que o critério 2 exige.
 *
 * Importar o barrel resolveria a duplicação e criaria coisa pior: ele exporta
 * `createPermissionsModule`, que puxa `pg` e os repositórios Postgres. Este
 * arquivo é domínio puro e hoje tem ZERO imports — a importação meteria o driver de
 * banco no grafo de um módulo que não fala com banco.
 *
 * O dano REAL da duplicação é a divergência silenciosa (a chave muda de um lado
 * e a projeção autoriza enquanto isto nega). Esse dano está fechado por
 * `src/modules/worker/__tests__/paridadeDeCelulas.test.ts`, que reprova se as
 * duas deixarem de bater.
 */
export const CELL_WORKER_DISABLE = 'worker:disable';

/** Prefixo de ator do próprio prestador no histórico (D95). */
export const PREFIXO_TITULAR = 'worker_self:';

export type MotivoRecusa =
  | 'sem_celula_de_baixa'
  | 'motivo_obrigatorio'
  | 'baixa_do_titular';

export interface DecisaoDeTransicao {
  permitida: boolean;
  motivoRecusa?: MotivoRecusa;
  /** Legenda pronta para a resposta HTTP — a tela não inventa texto. */
  explicacao?: string;
}

const PERMITIDA: DecisaoDeTransicao = { permitida: true };

function recusa(motivoRecusa: MotivoRecusa, explicacao: string): DecisaoDeTransicao {
  return { permitida: false, motivoRecusa, explicacao };
}

/** A transição toca a baixa? Entrar OU sair de `DISABLED`. */
export function tocaABaixa(de: WorkerStatus | null, para: WorkerStatus): boolean {
  return para === 'DISABLED' || de === 'DISABLED';
}

export interface EntradaDaDecisao {
  de: WorkerStatus | null;
  para: WorkerStatus;
  /**
   * Células do ator. `null` = o engine não decidiu nesta request → devolve o
   * comportamento anterior (D113). **Nunca `[]` por omissão.**
   */
  cells: string[] | null;
  motivo?: string | null;
  /** `changed_by` da linha que colocou em DISABLED, quando há. */
  autorDaBaixa?: string | null;
}

export function decidirTransicaoDeBaixa(e: EntradaDaDecisao): DecisaoDeTransicao {
  if (!tocaABaixa(e.de, e.para)) return PERMITIDA;

  // C8 vem ANTES da célula, e o que a ordem muda é a RAZÃO, não a decisão —
  // nos dois arranjos a transição é negada. A razão é que importa: dizer
  // "falta worker:disable" quando a verdade é "o titular pediu" manda o
  // operador buscar uma permissão que não resolveria, e faz a recusa parecer
  // um problema de acesso quando é vontade da pessoa. Há teste fixando a razão,
  // justamente para esta ordem não ser reorganizada por engano.
  const saindoDaBaixa = e.de === 'DISABLED' && e.para !== 'DISABLED';
  if (saindoDaBaixa && (e.autorDaBaixa ?? '').startsWith(PREFIXO_TITULAR)) {
    return recusa(
      'baixa_do_titular',
      'A baixa foi pedida pelo próprio prestador e não é revertida pelo painel. ' +
      'A reativação depende de novo pedido dele.',
    );
  }

  // `null` = engine não decidiu; o rollout exige comportamento inalterado.
  if (e.cells !== null && !e.cells.includes(CELL_WORKER_DISABLE)) {
    return recusa(
      'sem_celula_de_baixa',
      'Dar e reverter baixa exige a permissão "worker:disable".',
    );
  }

  if (!e.motivo || e.motivo.trim().length === 0) {
    return recusa(
      'motivo_obrigatorio',
      'Dar ou reverter baixa exige um motivo escrito — ele é o que a auditoria lê.',
    );
  }

  return PERMITIDA;
}
