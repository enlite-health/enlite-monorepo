/**
 * catalogRefresher - pure catalog-drift detection helpers.
 *
 * ── 11/09/2026 — remoção do sync automático ClickUp ──────────────────────────
 * A classe `ClickUpCatalogRefresher` (reload sob demanda, cooldowns, single-flight) e
 * `unsettledDriftThatMatters` foram removidas junto com `ClickUpPatientWebhookController` —
 * essa orquestração existia só para o processo de vida longa do webhook (catálogo é FOTO de
 * boot, `ClickUpFieldResolver.fromList` roda uma vez em `startServer.ts`). O script manual
 * busca um catálogo fresco a cada invocação (`ClickUpFieldResolver.fromList` de novo), então
 * o problema de "foto ficou velha entre eventos" não existe mais nesse caminho.
 * `findCatalogDrift` e `staleCatalogImpactOnMapper` ficam: são funções puras, sem rede,
 * usadas por `tests/unit/__tests__/clickup-2.2-segmento-cru.test.ts` (mapeamento de rótulo
 * cru, não do webhook).
 *
 * WHY THIS FILE EXISTS (task 1.13 da change `campos-admissao`, achado do QA-caca / F48):
 *
 * The 1.11 preflight (`dropdownCatalogGuard`) asks the CATALOG whether every drop_down the
 * mapper depends on is still readable. That is the right question asked of the wrong copy:
 *
 *   - the TASK arrives fresh from `GET /task/<id>` on every single webhook;
 *   - the CATALOG is a PHOTO taken once, in `ClickUpFieldResolver.fromList`, whose only
 *     call site in `src/` is `ClickUpPatientWebhookController.create()` - run once, at boot
 *     (`bootstrap/startServer.ts`). No TTL, no reload, no invalidation.
 *
 * So between a rename in ClickUp and the next process restart, the preflight compares the
 * fresh task against a photo in which the field STILL EXISTS: nothing throws, `cf['<old
 * name>']` is `undefined`, `asIndexable` returns a silent `null`, and
 * `UPDATE ... SET clinical_specialty = $11` (no COALESCE, by D-E) writes that null over
 * stored data - with `kind=UPDATED` logged green. That is precisely the loss D167 decided to
 * stop, on the only path that runs in production.
 *
 * -- THE DESIGN, AND WHY THIS ONE --------------------------------------------
 *
 * Chosen: ON-DEMAND INVALIDATION driven by the live task. NOT a TTL, NOT a per-request read.
 *
 * The task payload itself carries the evidence that the photo is stale - every custom field
 * comes back with its `name` AND its `type`. Comparing that against the snapshot costs zero
 * network and catches the rename at the first webhook that follows it, instead of "within
 * one TTL". A TTL pays a request every window whether or not anything moved, and STILL
 * leaves a silent-erasure window of up to one TTL. Invalidation pays only when something
 * actually diverged.
 *
 * Four signals, all read off the live task:
 *
 *   `unknown_field`   - the task carries a field name the snapshot has never heard of.
 *                       A rename produces exactly this (the new name appears).
 *   `type_changed`    - the task reports a different `type` than the snapshot does for the
 *                       same name. This is the F33 scenario (drop_down -> labels).
 *   `declared_absent` - a declared drop_down the snapshot still lists is not on the task at
 *                       all. This is what a pure DELETE looks like (no new name appears).
 *   `option_unknown`  - name and type agree, but the task's VALUE points at options the
 *                       snapshot cannot translate. An option recreated in ClickUp changes the
 *                       OPTION uuid and leaves the field name alone, so the three signals
 *                       above never fired: measured by the QA of task 2.2, round 2, defect 1.
 *                       Probed with the SAME reader the mapper uses (`resolveCatalogValue`),
 *                       never with a second hand-written rule.
 *                       COST, declared: on a task whose options do not resolve, the resolver's
 *                       own per-item warning is emitted TWICE - once by this probe, once by
 *                       the live read in the mapper. Deduplicating it would mean not reusing
 *                       the mapper's reader, and a second rule diverges in silence (F20/F49/F51).
 *
 * -- THE COST, STATED PLAINLY -------------------------------------------------
 *
 * The webhook is the hottest path in the service, so an extra network call there is not
 * free and is not hidden here:
 *
 *   - steady state (nothing renamed): ZERO extra calls. The check is in-memory.
 *   - a rename/retype: ONE extra `/list/<id>/field` call, on the first webhook after it.
 *   - a field name the catalog will never know (someone's own field, a space-level field):
 *     ONE call, then never again - the drift is memoised as CONFIRMED after a fresh read,
 *     so a benign divergence cannot turn into a per-webhook network loop.
 *   - `declared_absent` cannot be memoised (a fresh read is the only thing that can ever
 *     disprove it, and the answer can change), so it is rate-limited instead:
 *     at most one reload per `declaredAbsentCooldownMs` (default 60 s) - bounded at ~1
 *     request/minute in the worst case, not one per webhook.
 *   - a FAILED reload starts a quiet period (`failureCooldownMs`, default 60 s) so a broken
 *     ClickUp API cannot be amplified into one failing request per webhook.
 *
 * -- WHAT THE CALLER MUST DO WITH A FAILED RELOAD -----------------------------
 *
 * Fail closed - but on the RIGHT question. Task 1.13b: the first cut of this file decided by
 * WHICH SIGNAL had appeared (`drift.fromTask.length > 0`), and that was wrong in BOTH
 * directions, both measured:
 *
 *   - it WROTE when it should have refused: a failed reload whose only drift was
 *     `declared_absent` let the mapper derive from a snapshot the file had just declared
 *     suspect - 10 webhooks, 10 writes, `serviceType=null` over stored data;
 *   - it REFUSED when nothing was wrong: one NEW field in the list that the mapper never
 *     reads, plus `/list/<id>/field` down, stopped 100% of the sync - 0 writes where the
 *     pre-1.13 code did 10. That was a regression of 1.13 itself.
 *
 * The signal was never the question. The question is: **does the mapper actually READ a field
 * that this suspect snapshot can no longer serve for THIS task?** The 1.12 harvester already
 * knows exactly which names the mapper asks for (`ClickUpPatientMapper.fieldNamesReadFor`), so
 * the answer is derived from what the code just read - never from a second hand-written list,
 * which is the failure mode F20/F49/F51 keeps re-teaching.
 *
 * `staleCatalogImpactOnMapper()` answers it; `unsettledDriftThatMatters()` gates it on the
 * reload having actually failed. Empty harvest = "I do not know" = fail closed (F19: a zero
 * count is a failure, never a success).
 *
 * -- THE API THAT HANGS, NOT THE ONE THAT FAILS (task 1.13b) ------------------
 *
 * The quiet period above only ever armed in the `catch`. An API that never answers never
 * rejects, so `lastFailureAt` was never set and the quiet period never engaged: measured, 5
 * sequential webhooks opened 5 reads and none of them came back, while the SAME sequence
 * against an API that fails fast stayed at 1. Two things close it, and they are different
 * things:
 *
 *   - TIME: every reload runs under a deadline (`loadTimeoutMs`, default 5 s) and the
 *     `AbortSignal` is handed to the loader, so the request is aborted, not just abandoned.
 *     A timeout is a failure like any other - it arms the quiet period.
 *   - CONCURRENCY: reloads are single-flight. Concurrent webhooks seeing the same stale
 *     snapshot JOIN the read already in flight instead of opening one each. What they wait on
 *     is bounded by the same deadline.
 *
 * -- LOG FORMAT - C1 do parecer do `lex`, and it is a PARE if violated --------
 *
 * Nothing here logs a VALUE. What is emitted is field NAME + field TYPE + counts - schema
 * metadata, the same class of information `dropdownCatalogGuard` already emits. No
 * orderindex, no option uuid, no resolved label, no `task.id`.
 */

import type { ClickUpFieldResolver } from '../ClickUpFieldResolver';
import type { ClickUpTaskCustomField } from '../ClickUpTask';
import {
  CATALOG_TYPES_SUPPORTED,
  REASONS_A_FRESH_CATALOG_CAN_SETTLE,
  resolveCatalogValue,
} from './resolveCatalogValue';

export type CatalogDriftKind =
  | 'unknown_field'
  | 'type_changed'
  | 'declared_absent'
  /**
   * O nome e o tipo do campo batem, mas o VALOR da tarefa aponta para opções que a foto não
   * conhece — defeito 1 da 2ª rodada de QA da task 2.2.
   *
   * Os três sinais originais são todos de CAMPO. Uma opção recriada ou apagada no ClickUp
   * muda o uuid da OPÇÃO e deixa o nome do campo intacto: a deriva nunca disparava, a recarga
   * nunca acontecia e a foto do boot ficava errada INDEFINIDAMENTE. Com o conserto do
   * defeito 1, a leitura passa a ser `readable:false` (nada é apagado) — mas sem este sinal
   * o campo ficaria ilegível para sempre, e trocar "apaga em silêncio" por "recusa para
   * sempre" é trocar de defeito.
   *
   * ⚠️ Só entram as razões que uma RELEITURA pode de fato assentar
   * (`REASONS_A_FRESH_CATALOG_CAN_SETTLE`). Valor que não tem forma de opção (`value_not_
   * indexable`, a classe da C5) é dado ruim, não foto velha: nenhuma recarga o conserta, e
   * contá-lo aqui seria pagar uma chamada de rede por tarefa suja.
   */
  | 'option_unknown';

export interface CatalogDriftItem {
  /** Field name. Schema metadata - never a patient value. */
  field: string;
  kind: CatalogDriftKind;
  /** Type the LIVE task reports for this field (null when the task does not carry it). */
  taskType: string | null;
  /** Type the SNAPSHOT reports for the same name (null when the snapshot does not know it). */
  catalogType: string | null;
  /**
   * `option_unknown` only: how many options the task sent and how many the snapshot resolved.
   * COUNTS, never ids - this item is logged whole by the controller, and C1 permits counts
   * ("field X dropped N values this run") but never the coded clinical value.
   */
  optionsRequested?: number;
  optionsResolved?: number;
}

export interface CatalogDrift {
  items: CatalogDriftItem[];
  /** Drift a fresh read can SETTLE: the snapshot has never seen this name/type. */
  fromTask: CatalogDriftItem[];
  /** Drift only a fresh read can DISPROVE: a declared field the live task no longer carries. */
  fromDeclared: CatalogDriftItem[];
}

/**
 * O VALOR desta tarefa resolve contra a foto? Puro, sem rede, sem lançar - e sem avisar
 * (`warn:false`), porque o caminho vivo do mapper ja emite o aviso desse mesmo fato.
 *
 * Deriva do MESMO leitor que o mapper usa (`resolveCatalogValue`) de proposito: uma segunda
 * regra escrita a mao para decidir "esta opcao resolve?" divergiria da primeira em silencio,
 * que e o F20/F49/F51 desta casa.
 *
 * LIMITE DECLARADO: a memoizacao (`driftKey`) distingue as ocorrencias por CONTAGEM, nao pela
 * identidade das opcoes - carregar uuid dentro do item seria vaza-lo no log do controller,
 * que emite o item inteiro. Consequencia: depois de uma releitura que NAO assentou a deriva,
 * outra opcao desconhecida do MESMO campo com as MESMAS contagens nao dispara nova releitura
 * ate que qualquer recarga bem-sucedida limpe as confirmacoes.
 */
function optionDriftFor(
  snapshot: Pick<ClickUpFieldResolver, 'getFieldType' | 'resolveDropdown' | 'resolveLabels'>,
  fieldName: string,
  catalogType: string | null,
  taskType: string | null,
  raw: unknown,
): CatalogDriftItem | null {
  if (catalogType === null) return null;
  if (!(CATALOG_TYPES_SUPPORTED as readonly string[]).includes(catalogType)) return null;

  const read = resolveCatalogValue(snapshot, fieldName, raw, { warn: false });
  if (read.readable) return null;
  if (!REASONS_A_FRESH_CATALOG_CAN_SETTLE.includes(read.reason)) return null;

  return {
    field: fieldName,
    kind: 'option_unknown',
    taskType,
    catalogType,
    optionsRequested: read.requested,
    optionsResolved: read.resolved,
  };
}

/**
 * Does the LIVE task disagree with the CATALOG snapshot? Pure, no network, no throw.
 *
 * Trailing/leading spaces are tolerated on BOTH sides on purpose: `buildCustomFieldMap`
 * already indexes the trimmed name (task 1.12), so a space-only rename cannot lose a value
 * and must not raise a stale-catalog alarm. It is not this function's job to second-guess
 * that alias - only to notice a name or a type the snapshot genuinely does not have.
 */
export type CatalogSnapshotProbe =
  Pick<ClickUpFieldResolver, 'getFieldType' | 'resolveDropdown' | 'resolveLabels'>;

export function findCatalogDrift(
  snapshot: CatalogSnapshotProbe,
  taskFields: readonly ClickUpTaskCustomField[] | null | undefined,
  declaredFields: readonly string[],
): CatalogDrift {
  const items: CatalogDriftItem[] = [];
  const namesOnTask = new Set<string>();
  // A sonda de OPÇÃO só roda para os campos DECLARADOS: são os que o mapper depende de ler.
  // Varrer todo campo da lista pagaria uma releitura por opção nova de campo que ninguém lê.
  const declarados = new Set<string>(declaredFields.map(d => d.trim()));

  for (const field of taskFields ?? []) {
    const name = typeof field?.name === 'string' ? field.name : '';
    if (name === '') continue;
    namesOnTask.add(name);
    namesOnTask.add(name.trim());

    const catalogType = snapshot.getFieldType(name) ?? snapshot.getFieldType(name.trim());
    const taskType    = typeof field.type === 'string' && field.type !== '' ? field.type : null;

    if (catalogType === null) {
      items.push({ field: name, kind: 'unknown_field', taskType, catalogType: null });
      continue;
    }
    if (taskType !== null && taskType !== catalogType) {
      items.push({ field: name, kind: 'type_changed', taskType, catalogType });
      continue;
    }

    // Nome bate e tipo bate. Falta a pergunta que os três sinais originais não faziam: o
    // VALOR desta tarefa resolve contra esta foto? (defeito 1 da 2ª rodada de QA da 2.2)
    if (!declarados.has(name.trim())) continue;
    const nomeNoCatalogo = snapshot.getFieldType(name) !== null ? name : name.trim();
    const opcao = optionDriftFor(snapshot, nomeNoCatalogo, catalogType, taskType, field.value);
    if (opcao !== null) items.push({ ...opcao, field: name });
  }

  for (const declared of declaredFields) {
    const catalogType = snapshot.getFieldType(declared);
    // The snapshot not knowing a DECLARED field is the 1.11 preflight's business, not drift.
    if (catalogType === null) continue;
    if (namesOnTask.has(declared) || namesOnTask.has(declared.trim())) continue;
    items.push({ field: declared, kind: 'declared_absent', taskType: null, catalogType });
  }

  return {
    items,
    fromTask:     items.filter(i => i.kind !== 'declared_absent'),
    fromDeclared: items.filter(i => i.kind === 'declared_absent'),
  };
}

/**
 * Which of the names the MAPPER READS this (suspect) snapshot can no longer serve for this
 * task. Pure, no network, no throw. Every item here is a field the mapper will actually touch:
 * a name it never asks for cannot appear, whatever the ClickUp list gained or lost.
 *
 * Four ways a stale photo breaks a read the mapper is about to make:
 *   `declared_absent` - the catalog says the field exists, the live task does not carry it.
 *                       `cf['<name>']` is `undefined`, `asIndexable` returns a silent null and
 *                       the `UPDATE` (no COALESCE, D-E) erases. This is the D167 erosion.
 *   `unknown_field`   - the task carries the name, the catalog has never heard of it, so a
 *                       drop_down cannot be resolved from it at all.
 *   `type_changed`    - both have the name, with different types (the F33 drop_down -> labels).
 *   `option_unknown`  - name and type agree and the task's VALUE points at options this photo
 *                       cannot translate. Without it, a FAILED reload let the mapper derive
 *                       `null` from a snapshot this file had just declared suspect, and the
 *                       `UPDATE` (no COALESCE, D-E) erased. Round 2, defect 1.
 *
 * DELIBERATELY NOT HERE: a name the mapper asks for that is on NEITHER side. That is a wrong
 * NAME (the 1.12 class), not a stale photo - it is true for every task, so counting it would
 * stop the sync forever and no reload could ever settle it.
 *
 * LIMIT, DECLARED: a catalog field spelled with padding (F15: `'Cobertura Informada '`) that is
 * ALSO missing from the live task is not reported. `getFieldType` matches exactly and the
 * resolver exposes no name list to scan, so the trimmed alias can only be recovered from the
 * task's own spelling - and here there is no task entry to recover it from. Conservative on
 * purpose: the alternative would fail closed on a name mismatch that no reload can settle.
 */
export function staleCatalogImpactOnMapper(
  snapshot: CatalogSnapshotProbe,
  taskFields: readonly ClickUpTaskCustomField[] | null | undefined,
  mapperFieldNames: readonly string[],
): CatalogDriftItem[] {
  const onTaskByName = new Map<string, ClickUpTaskCustomField>();
  for (const field of taskFields ?? []) {
    const name = typeof field?.name === 'string' ? field.name : '';
    if (name === '') continue;
    if (!onTaskByName.has(name)) onTaskByName.set(name, field);
    const trimmed = name.trim();
    if (!onTaskByName.has(trimmed)) onTaskByName.set(trimmed, field);
  }

  const out: CatalogDriftItem[] = [];
  const seen = new Set<string>();

  for (const requested of mapperFieldNames) {
    if (typeof requested !== 'string') continue;
    const name = requested.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);

    const onTask   = onTaskByName.get(requested) ?? onTaskByName.get(name);
    const taskType = onTask && typeof onTask.type === 'string' && onTask.type !== '' ? onTask.type : null;

    // O catálogo é consultado pela grafia da TAREFA quando ela existe, e só depois pela grafia
    // pedida. Sem isto o alias da 1.12 vira falso positivo: o mapper pede `Cobertura
    // Informada`, o campo vivo se chama `'Cobertura Informada '` COM espaço no fim (F15), e a
    // consulta exata devolveria `null` — acusando "o catálogo nunca ouviu falar" de um campo
    // que está lá. Medido: era 1 item de impacto fantasma em TODA tarefa, e ele sozinho
    // reprovava o conserto (b).
    const nomeNoCatalogo = onTask?.name ?? requested;
    const catalogType =
      snapshot.getFieldType(nomeNoCatalogo) ??
      snapshot.getFieldType(nomeNoCatalogo.trim()) ??
      snapshot.getFieldType(name);

    if (onTask === undefined) {
      if (catalogType !== null) {
        out.push({ field: name, kind: 'declared_absent', taskType: null, catalogType });
      }
      continue;
    }
    if (catalogType === null) {
      out.push({ field: name, kind: 'unknown_field', taskType, catalogType: null });
      continue;
    }
    if (taskType !== null && taskType !== catalogType) {
      out.push({ field: name, kind: 'type_changed', taskType, catalogType });
      continue;
    }

    // A quarta forma de a foto velha quebrar uma leitura que o mapper está prestes a fazer:
    // o campo está lá, com o tipo certo, e a OPÇÃO que a tarefa aponta não existe na foto.
    // Sem isto, um reload FALHO deixava o mapper derivar `null` de uma foto que este arquivo
    // acabou de declarar suspeita — e o `UPDATE` sem COALESCE (D-E) apaga.
    const opcao = optionDriftFor(snapshot, nomeNoCatalogo, catalogType, taskType, onTask.value);
    if (opcao !== null) out.push({ ...opcao, field: name });
  }

  return out;
}
