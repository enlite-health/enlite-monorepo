/**
 * src/shared/audit/actorSource.ts
 *
 * Fonte canônica de ATOR das ações de recrutamento — quem executou a escrita.
 *
 * É o eixo da pergunta "quanto a Luz fez × quanto cada pessoa do time fez"
 * (change rastreabilidade-ator-recrutamento). Vale para as trilhas que os
 * triggers do banco preenchem:
 *   - worker_job_application_stage_history (movimento de etapa no funil)
 *   - worker_status_history               (mudança de status do worker)
 *
 * Convenção de gravação:
 *   changed_by    = identidade legível com PREFIXO de fonte (`staff:<uid>`,
 *                   `luz:<tool>`, `worker_self`, `system:<job>`, `sync:<x>`)
 *   change_source = o enum, quando a trilha tiver a coluna preenchível
 *
 * O prefixo em `changed_by` é intencional: a leitura deriva a fonte dele
 * (`actorSourceFromChangedBy`), então a medição funciona **sem alterar os
 * triggers do banco** — só o valor gravado muda.
 *
 * Relação com `profileEditSource` (módulo worker): aquele é a fonte de edição de
 * CAMPO DE CADASTRO, já em produção desde D92/D93, e seus 4 valores são um
 * subconjunto destes. Os dois enums são deliberadamente separados — o de cadastro
 * é contrato de uma tabela que já tem dado gravado; mudá-lo quebraria a leitura
 * histórica. `FUNNEL_TO_PROFILE_SOURCE` faz a ponte na hora de agregar.
 */

export const ACTOR_SOURCES = [
  /** A Luz agindo na conversa (tools do triage). */
  'luz_conversation',
  /** O próprio prestador: app, wizard ou resposta de lembrete no WhatsApp. */
  'worker_self',
  /** Staff pelo painel admin (as recrutadoras). */
  'admin_panel',
  /** Rotina automática do próprio sistema: matching, scheduler, no-show, eventos. */
  'system_auto',
  /** Importação/sincronização com sistema externo (Talentum, Ana Care). */
  'sync_import',
] as const;

export type ActorSource = (typeof ACTOR_SOURCES)[number];

/** Ator de uma escrita: o que agrega (`source`) + quem foi (`id`). */
export interface ActorContext {
  source: ActorSource;
  /** Identidade legível — vai para `changed_by`. Ex.: `staff:flor@enlite.health`. */
  id: string;
}

/**
 * Staff do painel.
 *
 * Grava o **firebase_uid**, não o e-mail: o token real só traz uid (o e-mail
 * aparece apenas no mock de teste — ver AuthMiddleware), o uid é estável se a
 * pessoa trocar de e-mail, e assim a trilha não guarda dado pessoal de
 * funcionário. A leitura resolve o nome legível com um LEFT JOIN em `users`
 * (mesma técnica de WorkerAuditRepository.resolveActorEmail).
 * O e-mail entra só como fallback quando não há uid.
 */
export function staffActor(uid?: string | null, email?: string | null): ActorContext | null {
  const identity = uid?.trim() || email?.trim();
  if (!identity) return null;
  return { source: 'admin_panel', id: `staff:${identity}` };
}

/** A Luz executando uma tool. `tool` é o nome curto, ex.: 'baja-cuenta', 'apply'. */
export function luzActor(tool: string): ActorContext {
  return { source: 'luz_conversation', id: `luz:${tool}` };
}

/** O próprio prestador. `workerId` é opcional — a linha já é por worker. */
export function workerSelfActor(workerId?: string | null): ActorContext {
  return { source: 'worker_self', id: workerId ? `worker_self:${workerId}` : 'worker_self' };
}

/** Rotina automática. `job` identifica o processo, ex.: 'reminder-scheduler'. */
export function systemActor(job: string): ActorContext {
  return { source: 'system_auto', id: `system:${job}` };
}

/** Importação/sync externo. `integration` ex.: 'talentum'. */
export function syncActor(integration: string): ActorContext {
  return { source: 'sync_import', id: `sync:${integration}` };
}

/** Fatia da leitura para linha histórica sem ator (anterior à instrumentação). */
export const NOT_INSTRUMENTED = 'nao_instrumentado';

/**
 * Deriva a fonte a partir do `changed_by` gravado — é o que permite medir sem
 * depender da coluna `change_source` (e, portanto, sem alterar os triggers).
 *
 * Reconhece também os valores que já existiam em produção antes desta change:
 * `luz:baja-cuenta`, `luz:set-availability`, `lgpd:...`, `system:merge-orphan-fix-...`.
 * Linha sem autor (o histórico anterior à instrumentação) → `nao_instrumentado`.
 */
export function actorSourceFromChangedBy(
  changedBy: string | null | undefined,
): ActorSource | typeof NOT_INSTRUMENTED {
  const value = changedBy?.trim();
  if (!value) return NOT_INSTRUMENTED;
  if (value.startsWith('staff:')) return 'admin_panel';
  if (value.startsWith('luz:') || value === 'luz') return 'luz_conversation';
  if (value.startsWith('worker_self')) return 'worker_self';
  if (value.startsWith('sync:')) return 'sync_import';
  if (value.startsWith('system:') || value.startsWith('lgpd:')) return 'system_auto';
  // Valor desconhecido: não inventar autoria — cai na fatia explícita.
  return NOT_INSTRUMENTED;
}

/** SQL equivalente de `actorSourceFromChangedBy`, para agregar no banco. */
export function actorSourceSql(column: string): string {
  return `CASE
    WHEN ${column} IS NULL OR btrim(${column}) = '' THEN '${NOT_INSTRUMENTED}'
    WHEN ${column} LIKE 'staff:%'                   THEN 'admin_panel'
    WHEN ${column} LIKE 'luz:%' OR ${column} = 'luz' THEN 'luz_conversation'
    WHEN ${column} LIKE 'worker_self%'              THEN 'worker_self'
    WHEN ${column} LIKE 'sync:%'                    THEN 'sync_import'
    WHEN ${column} LIKE 'system:%' OR ${column} LIKE 'lgpd:%' THEN 'system_auto'
    ELSE '${NOT_INSTRUMENTED}'
  END`;
}

/**
 * Ponte com o enum de cadastro (`ProfileEditSource`) na hora de agregar as três
 * trilhas juntas. `system_auto` não tem par lá — cadastro automático é `sync_import`.
 */
export const PROFILE_SOURCE_TO_ACTOR_SOURCE: Record<string, ActorSource> = {
  luz_conversation: 'luz_conversation',
  // legado pré-enum (default da migration 202)
  luz: 'luz_conversation',
  worker_self: 'worker_self',
  admin_panel: 'admin_panel',
  sync_import: 'sync_import',
};
