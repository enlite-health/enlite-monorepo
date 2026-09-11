/**
 * import-patients-from-clickup-flags.ts
 *
 * Parser PURO dos flags do CLI de `import-patients-from-clickup.ts`. Extraído para ser
 * testável sem rodar o script inteiro (que faz I/O de rede/DB e `process.exit`) — mesmo padrão
 * de `backfill-diagnosis-catalog/cli-guards.ts` (D10 do ingestor CID-11): falha VISÍVEL, nunca
 * escrita por omissão.
 *
 * Duas travas fail-safe (achado do gate revisao-pr, BLOCKER/MAJOR):
 *   1. `--dry-run` presente VENCE `--apply`, sempre — nunca existe combinação de flags que
 *      grave se `--dry-run` foi digitado (mesma disciplina de `parseBackfillFlags`).
 *   2. TODA flag que espera um VALOR (`--task-id`, `--limit`, `--status`) trata "sem valor
 *      depois" ou "seguido de outra flag" como ERRO, nunca como "flag ausente" — sem isto,
 *      `--status` digitado errado (ex.: `--apply --status`, esqueceu o valor) caía MUDO em
 *      `statusFilter: []`, que o código lê como "sem filtro" = LISTA INTEIRA gravando. Mesma
 *      classe de defeito que `--task-id` sem valor (caía na paginação da lista inteira) e
 *      `--limit` não numérico (caía em "sem limite") — achada por gate de revisão em `--status`
 *      DEPOIS de já ter sido corrigida em `--task-id`/`--limit`: mesma régua, os 3 agora.
 *   3. `--task-id ""` (string vazia ou só espaços) é ERRO — sem isto, `--task-id " "` passava
 *      no `looksLikeAnotherFlag` (não é undefined, não começa com `--`) e virava uma chamada
 *      `GET /task/ ` real. `--task-id` junto de `--limit`/`--status` também é ERRO: as duas
 *      são flags do caminho de PAGINAÇÃO (lista inteira), incompatíveis com a busca de UMA
 *      task por id — combinar as duas seria silenciosamente ignorar uma delas.
 *
 * Por isso o parser devolve um RESULTADO (`ok: true` com os flags, ou `ok: false` com a
 * mensagem) em vez de lançar ou sair do processo — quem decide como reportar o erro (console +
 * `process.exit`) é o script, não este arquivo puro.
 */

export interface ImportPatientsFlags {
  /** true = grava no banco. Default false (dry-run). `--dry-run` sempre vence `--apply`. */
  apply: boolean;
  /** `--task-id <id>`: carga pontual de UMA task (cobre a CRIAÇÃO que resync-one-clickup-task.ts,
   *  removido 11/09/2026, também cobria — NÃO cobre mais o reprocessamento de um card com
   *  CASE_NUMBER_CONFLICT já resolvido no ClickUp, que era o outro uso daquele script: esse
   *  caso é sempre um paciente que JÁ EXISTE, e a regra "só cria" recusa. Gap conhecido, sem
   *  caminho manual hoje). null = nenhum `--task-id` foi passado. */
  taskId: string | null;
  /** `--limit N`: processa só as N primeiras tasks (após filtro de status). null = sem limite. */
  limit: number | null;
  /** `--status X,Y,Z`: filtra por `status.status` (comma-separated, case-insensitive). */
  statusFilter: string[];
  /** `--verbose`: imprime o payload mapeado inteiro por task. */
  verbose: boolean;
}

export type ParseFlagsResult =
  | { ok: true; flags: ImportPatientsFlags }
  | { ok: false; error: string };

function looksLikeAnotherFlag(value: string | undefined): boolean {
  return value === undefined || value.startsWith('--');
}

/** Além de "outra flag"/"ausente": string vazia ou só espaço também não é um valor de verdade
 *  (achado do gate — `--task-id " "` passava e virava `GET /task/ ` real). */
function isMissingValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.startsWith('--') || value.trim() === '';
}

export function parseImportPatientsFlags(argv: string[]): ParseFlagsResult {
  // ── --dry-run vence --apply, sempre (fail-safe) ─────────────────────────────
  const hasDryRunFlag = argv.includes('--dry-run');
  const hasApplyFlag  = argv.includes('--apply');
  const apply = hasApplyFlag && !hasDryRunFlag;

  // ── --task-id: sem valor (ou seguido de outra flag, ou string vazia/só espaço) é ERRO ────────
  const taskIdIdx = argv.indexOf('--task-id');
  let taskId: string | null = null;
  if (taskIdIdx !== -1) {
    const value = argv[taskIdIdx + 1];
    if (isMissingValue(value)) {
      return {
        ok: false,
        error: `--task-id requer um valor não-vazio (ex.: --task-id 86abq2pzg) — recebido: ${value === undefined ? '<nada>' : JSON.stringify(value)}`,
      };
    }
    taskId = value as string;
  }

  // ── --limit: não numérico ou ≤ 0 é ERRO, nunca "sem limite" ─────────────────
  const limitIdx = argv.indexOf('--limit');
  let limit: number | null = null;
  if (limitIdx !== -1) {
    const raw = argv[limitIdx + 1];
    const parsed = raw !== undefined ? Number(raw) : NaN;
    const valido = raw !== undefined && Number.isInteger(parsed) && parsed > 0;
    if (!valido) {
      return {
        ok: false,
        error: `--limit precisa ser um inteiro positivo — recebido: ${raw ?? '<nada>'}`,
      };
    }
    limit = parsed;
  }

  // ── --status: sem valor (ou seguido de outra flag) é ERRO, nunca "sem filtro" ───────────────
  // Sem esta guarda, `--apply --status` (esqueceu o valor) caía muda em `statusFilter: []`, que
  // o script lê como "nenhum filtro" — LISTA INTEIRA gravando. Mesma disciplina de --task-id.
  const statusIdx = argv.indexOf('--status');
  let statusFilter: string[] = [];
  if (statusIdx !== -1) {
    const value = argv[statusIdx + 1];
    if (looksLikeAnotherFlag(value)) {
      return {
        ok: false,
        error: `--status requer um valor (ex.: --status busqueda,activo) — recebido: ${value ?? '<nada>'}`,
      };
    }
    statusFilter = (value as string).split(',').map(s => s.trim().toLowerCase());
  }

  const verbose = argv.includes('--verbose');

  // ── --task-id é incompatível com --limit/--status (caminhos diferentes: 1 task por id vs
  // paginação da lista inteira) — combinar as duas é ERRO, nunca "ignora uma delas em silêncio".
  if (taskId !== null && (limit !== null || statusFilter.length > 0)) {
    return {
      ok: false,
      error: '--task-id não pode ser combinado com --limit/--status — são flags do caminho de paginação (lista inteira), incompatíveis com a busca de UMA task por id.',
    };
  }

  // ── --apply só com --task-id (lex): carga em massa NUNCA grava ──────────────────────────────
  // A ferramenta manual só está autorizada a CRIAR um paciente novo por vez, com autorização
  // escrita do Gabriel por carga (ver cabeçalho do script) — nunca uma passada em massa sobre a
  // lista inteira. `--apply` sem `--task-id` é ERRO, não "processa tudo".
  if (apply && taskId === null) {
    return {
      ok: false,
      error: '--apply só é permitido junto de --task-id — carga em massa (lista inteira) nunca grava, por decisão do lex (11/09/2026).',
    };
  }

  return { ok: true, flags: { apply, taskId, limit, statusFilter, verbose } };
}
