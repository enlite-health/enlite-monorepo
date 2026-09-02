import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';

/**
 * templateCatalogView — as regras da faixa de filtros e do indicador de
 * sincronização, fora do componente (pages só orquestram).
 *
 * 🔒 O agrupamento é a decisão que importa, e ele NÃO é cosmético:
 *
 *   `pending`   — está em revisão. Ninguém precisa fazer nada, é esperar.
 *   `off`       — a Meta DESLIGOU algo que estava no ar (pausada, desabilitada,
 *                 limite excedido). Isto é incidente operacional: alguém
 *                 denunciou a mensagem, ou a conta bateu num teto.
 *   `unchecked` — nunca perguntamos à Meta. É ausência de informação nossa,
 *                 não estado dela. Juntar isto com `pending` faria a tela
 *                 afirmar algo que ela não sabe.
 *   `other`     — estado que a Meta criou depois deste código. Grupo próprio
 *                 para que apareça em vez de sumir; descartar o desconhecido
 *                 foi o que escondeu PAUSED de nós até 31/08/2026.
 */

export type StatusGroup = 'draft' | 'approved' | 'pending' | 'rejected' | 'off' | 'unchecked' | 'other';
export type FilterKey = StatusGroup | 'all';

/** Ordem em que os filtros aparecem. `all` primeiro, `other` por último. */
/**
 * Ordem em que os filtros aparecem — a do desenho: todas, rascunhos, em
 * revisão, aprovadas, rejeitadas. Depois vêm os três que o desenho não tem.
 *
 * ⚠️ `off`, `unchecked` e `other` FICARAM, e a maquete não os desenha. Ela é de
 * 31/08, um dia antes de descobrirmos que a Meta DESLIGA mensagens que já
 * estavam no ar (PAUSED/DISABLED) e que o nosso tipo nem previa esses estados.
 * `off` é o filtro do incidente: alguém denunciou a mensagem, ou a conta bateu
 * num teto. Tirá-lo para bater com o desenho reintroduziria exatamente a
 * cegueira que este catálogo existe para acabar.
 */
export const FILTER_ORDER: readonly FilterKey[] = ['all', 'draft', 'pending', 'approved', 'rejected', 'off', 'unchecked', 'other'];

const POR_STATUS: Record<string, StatusGroup> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'off',
  DISABLED: 'off',
  LIMIT_EXCEEDED: 'off',
  ARCHIVED: 'other',
  PENDING_DELETION: 'other',
  DELETED: 'other',
};

/** `null` é "nunca verificado" — grupo próprio, nunca confundido com "em revisão". */
export function groupOf(status: string | null): StatusGroup {
  if (status === null) return 'unchecked';
  return POR_STATUS[status.toUpperCase()] ?? 'other';
}

/**
 * O grupo de uma LINHA — rascunho tem grupo próprio, antes de olhar o estado.
 *
 * 🔒 O rascunho vem com `metaStatus: null` e cairia em `unchecked`, que
 * significa "existe na Twilio e nunca perguntamos à Meta". São coisas
 * diferentes: o rascunho não existe em lugar nenhum fora daqui. Juntá-los faria
 * a contagem de "sin verificar" incluir mensagens que nunca foram criadas.
 */
export function grupoDaLinha(row: { metaStatus: string | null; isDraft?: boolean }): StatusGroup {
  return row.isDraft === true ? 'draft' : groupOf(row.metaStatus);
}

export type GroupCounts = Record<FilterKey, number>;

/**
 * Contagem por grupo, com todas as chaves presentes mesmo em zero.
 *
 * Chave ausente e chave em zero são coisas diferentes na hora de renderizar: a
 * faixa mostra o filtro com `0` em vez de escondê-lo, porque "nenhuma
 * rejeitada" é informação e um filtro que some é confuso.
 */
export function countByGroup(rows: TemplateCatalogRow[]): GroupCounts {
  const c = Object.fromEntries(FILTER_ORDER.map((k) => [k, 0])) as GroupCounts;
  c.all = rows.length;
  for (const r of rows) c[grupoDaLinha(r)]++;
  return c;
}

export function filterByGroup(rows: TemplateCatalogRow[], key: FilterKey): TemplateCatalogRow[] {
  return key === 'all' ? rows : rows.filter((r) => grupoDaLinha(r) === key);
}

/** A verificação mais recente do catálogo, ou null se ninguém foi verificado. */
export function lastCheckedAt(rows: TemplateCatalogRow[]): string | null {
  let melhor: string | null = null;
  let melhorMs = -Infinity;
  for (const r of rows) {
    if (!r.metaCheckedAt) continue;
    const ms = Date.parse(r.metaCheckedAt);
    if (Number.isNaN(ms) || ms <= melhorMs) continue;
    melhorMs = ms;
    melhor = r.metaCheckedAt;
  }
  return melhor;
}

export interface RelativeAge {
  unidade: 'now' | 'min' | 'hour' | 'day';
  valor: number;
}

/**
 * Idade de uma data, em partes — quem monta a frase é a tela, com i18n.
 *
 * ⚠️ Recebe o `agora` em vez de ler o relógio: função que lê `Date.now()` por
 * dentro não tem como ser testada sem congelar o tempo global, e o teste passa
 * a depender de quando roda.
 *
 * Data no futuro (relógio do servidor adiantado) vira `now`, nunca um número
 * negativo na tela.
 */
export function relativeFrom(iso: string, agora: Date): RelativeAge | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const seg = Math.floor((agora.getTime() - ms) / 1000);
  if (seg < 60) return { unidade: 'now', valor: 0 };
  const min = Math.floor(seg / 60);
  if (min < 60) return { unidade: 'min', valor: min };
  const hora = Math.floor(min / 60);
  if (hora < 24) return { unidade: 'hour', valor: hora };
  return { unidade: 'day', valor: Math.floor(hora / 24) };
}

/**
 * A data como uma pessoa lê, não como o Postgres devolve.
 *
 * ⚠️ Antes saía `2026-09-01T02:19:00Z` cru na tela do detalhe — o Gabriel viu em
 * 01/09/2026. Locale `es-AR` porque é o padrão do projeto (CLAUDE.md do
 * frontend). ISO inválida devolve `null`, e a tela então diz "nunca" — nunca
 * "Invalid Date", que é o que aparece quando se confia no `new Date()` cego.
 *
 * Mora aqui, e não no componente, porque exportar função de arquivo de
 * componente reprova em `react-refresh/only-export-components` — e o lint roda
 * com `--max-warnings 0`, então um aviso derruba o CI inteiro.
 */
export function dataLegivel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * A cor do estado da Meta.
 *
 * 🔒 MORA AQUI, e não na página, porque a listagem e a tela de detalhe têm de
 * pintar o MESMO estado da MESMA cor — duas cópias divergem no primeiro ajuste,
 * e aí "Pausada" vira uma cor na lista e outra no detalhe, sugerindo que são
 * coisas diferentes.
 *
 * Os estados de DESLIGAMENTO (a Meta tirou do ar algo que estava funcionando)
 * têm peso próprio: não são "pendente", são incidente.
 */
export function statusTone(status: string | null): string {
  switch (status) {
    // As opacidades vêm MEDIDAS da maquete (`.p-appr` .28, `.p-rev` .32,
    // `.p-rej` .26) — antes eram /25 e /30 arredondados por mim.
    case 'APPROVED': return 'bg-turquoise/[0.28] text-[#0B5C4E]';
    case 'PENDING': case 'IN_APPEAL': return 'bg-wait/[0.32] text-[#7A5200]';
    case 'REJECTED': return 'bg-pink-cancel/[0.26] text-[#8E1230]';
    case 'PAUSED': case 'DISABLED': case 'LIMIT_EXCEEDED': return 'bg-coordination/20 text-[#8E1230]';
    default: return 'bg-gray-300 text-gray-800';
  }
}
