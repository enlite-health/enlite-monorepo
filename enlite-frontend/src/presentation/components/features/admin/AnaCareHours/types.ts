/**
 * Tipos da tela "conferência de horas do Ana Care" (V1). Portado do protótipo clicável em
 * `repos/infra/_worktrees/proto-anacare-horas/enlite-frontend/.../AnaCareHours/types.ts`, adaptado
 * ao contrato HTTP fixo da fase 1 (backend implementado em paralelo por outro agente) e à D344
 * (`docs/decisoes.md`). Cada campo aponta o campo correspondente na proposta de schema
 * (`docs/funcionalidades/ana-care/proposta-schema-validacao-horas.md`), duas tabelas —
 * `anacare_shift` (retrato, só leitura) e `shift_hours_validation` (nosso OK, durável).
 *
 * Regra de produto travada: validação é por TURNO (`AnaCareShift`), nunca por prestador/paciente
 * inteiro — o agregado é sempre DERIVADO (ver `selectors.ts`), nunca guardado em duplicata aqui.
 *
 * DIVERGÊNCIA do protótipo (contrato HTTP fixo da fase 1): o campo `Validator { id, name }` foi
 * REMOVIDO por completo dos comandos de escrita — quem validou vem da sessão autenticada no
 * backend, nunca do payload que o front manda (`POST /shifts/:id/validate` tem corpo `{}`). Na
 * LEITURA, para não perder o requisito "'Validado por' mostra o NOME" (spec §Nome do
 * paciente/prestador..., cenário "'Validado por' mostra o nome e guarda o ID"), o turno valida
 * carrega só `validatedByName?: string` — nunca um id de outro usuário round-tripado ao front.
 */

/** ↔ `shift_hours_validation.approved_checkin_source` / `anacare_shift.checkin_source` (CHECK 'app'|'web_admin', null = sin check-in). */
export type CheckInOrigin = 'sin_checkin' | 'web_admin' | 'app';

/** ↔ `shift_hours_validation.status` (CHECK 'pendente'|'validado'|'contestado' — nomeado em es-AR aqui, é vocabulário de UI). */
export type ValidationStatus = 'pendiente' | 'validado' | 'contestado';

/**
 * Motivo de lista fechada da contestação (D344, revoga em parte D342/D343) — CHECK no banco.
 * Fonte: `docs/decisoes.md` D344; `openspec/changes/anacare-conferencia-de-horas/specs/
 * anacare-shift-hours/spec.md:296-298` ("Scenario: contestar exige motivo de lista fechada...").
 */
export type ContestReason = 'no_asistio' | 'horario_distinto' | 'horas_mal_cargadas' | 'otro';

/** Lista fechada, na ordem exibida no `<select>` do `ContestModal`. */
export const CONTEST_REASONS: readonly ContestReason[] = ['no_asistio', 'horario_distinto', 'horas_mal_cargadas', 'otro'];

/**
 * Limite de caracteres da nota opcional de contestação. A spec e a D344 pedem "um limite de
 * caracteres validado também no backend" mas NENHUM dos dois (nem `proposta-schema-validacao-
 * horas.md`) diz o número — escolha do Claude, documentada aqui (não estimada em silêncio): 500,
 * o mesmo teto já usado em outras notas curtas do painel (`Textarea` de observação).
 */
export const CONTEST_NOTE_MAX_LENGTH = 500;

export interface AnaCareShift {
  /** ↔ `anacare_shift.id` (bigserial, chave técnica local). */
  id: string;
  /** ↔ `anacare_shift.period_month` truncado ao dia — YYYY-MM-DD. */
  date: string;
  /** ↔ `anacare_shift.planned_start` (hora, sem tz). */
  scheduledStart: string;
  /** ↔ `anacare_shift.planned_end`. */
  scheduledEnd: string;
  /** ↔ `anacare_shift.checkin_at`. null = sin check-in (origin sempre 'sin_checkin' nesse caso). */
  actualStart: string | null;
  /** ↔ `anacare_shift.checkout_at`. */
  actualEnd: string | null;
  /** ↔ `anacare_shift.duration_hours` (ou, se validado, `shift_hours_validation.approved_hours`). null quando não há check-in. */
  hoursActual: number | null;
  /** Derivado de `planned_start`/`planned_end` — nunca guardado na fonte. */
  hoursScheduled: number;
  /** ↔ `anacare_shift.checkin_source`. */
  origin: CheckInOrigin;
  /** ↔ `shift_hours_validation.status`. */
  status: ValidationStatus;
  /**
   * ↔ `shift_hours_validation.validated_by` (FK), resolvido para `{id, name}` — MESMO shape que o
   * backend real manda (`AnaCareHoursMapper.ts` `Validator`). O `id` viaja no payload (contrato
   * HTTP fixo), mas a UI só renderiza `.name` — nunca o id (regra dura, D342). Presente só quando
   * status === 'validado'.
   */
  validatedBy?: { id: string; name: string };
  /** ↔ `shift_hours_validation.validated_at`. */
  validatedAt?: string;
  /** ↔ `shift_hours_validation.reason` (CHECK, lista fechada). Presente só quando status === 'contestado'. */
  contestReason?: ContestReason;
  /**
   * ↔ `shift_hours_validation.note_encrypted` (decifrado). Presente só quando status ===
   * 'contestado' E o ator tem `patient_clinical:read` — sem a célula o backend nunca manda o
   * campo (spec §Detalhe do paciente, cenário "nota do turno contestado só aparece com a célula
   * clínica"); a tela mostra "Nota restringida" quando `status === 'contestado'` e o campo está
   * ausente. Nota é OPCIONAL (D344, revoga em parte D342/D343: antes era obrigatória).
   */
  contestNote?: string;
  /** ↔ `anacare_shift.source_shift_id` (chave estável na fonte) — usado quando o prestador do turno não está vinculado. */
  anaCareShiftId: string;
}

export interface AnaCareProvider {
  /** ↔ `anacare_shift.ana_care_nurse_id` (identidade na fonte, ex.: "90231"). */
  anaCareId: string;
  /** ↔ `anacare_shift.worker_id IS NOT NULL` (FK resolvida) — INDEPENDENTE do nome (ver `name`). */
  linked: boolean;
  /**
   * Item 1 (decisão do Gabriel, 17/09, revoga a nota de 15/09 abaixo): vem do PAYLOAD do turno na
   * fonte, não do cruzamento com `workers` — `linked` não gate o nome. Ausente quando o ator não
   * tem `worker_contact:read` (gate mantido) ou quando a fonte não mandou nome para o turno.
   *
   * ⚠️ Hoje isso só se materializa no **DETALHE**, que vai à fonte ao vivo. A **LISTA** lê do
   * retrato (`anacare_shift`), que NÃO tem coluna de nome — decisão da granularidade do retrato
   * ainda aberta (D360 §"O que esta decisão NÃO fecha"). Na lista o valor vem `undefined` e a
   * tela cai no fallback honesto `Sin vínculo · ID X`.
   */
  name?: string;
  shifts: AnaCareShift[];
}

export interface AnaCarePatient {
  /** ↔ `anacare_shift.ana_care_patient_id`. */
  anaCareId: string;
  /** ↔ `anacare_shift.patient_id IS NOT NULL` — SEMPRE `false` hoje (D349 item 2, bloqueado: sem ID nosso do lado do paciente no Ana Care). */
  linked: boolean;
  /**
   * Item 1 (decisão do Gabriel, 17/09): vem do PAYLOAD do turno na fonte — INDEPENDENTE de
   * `linked` (que continua sempre `false`, D349 item 2). Ausente quando a fonte não mandou nome
   * para o turno, e ausente na LISTA enquanto o retrato não guardar nome (ver `AnaCareProvider.name`).
   */
  name?: string;
  /**
   * Documento de identidade do paciente (categoria/valor, ex. "DNI"/"30111222") — mesmo desenho de
   * `name`: vem do backend só quando o ator tem a célula `patient_identity:read` (gate de PII,
   * item 4 da conferência de horas, 18/09). Ausente (não vazio) sem a permissão — nunca redigido.
   */
  documentType?: string;
  documentNumber?: string;
  providers: AnaCareProvider[];
}

/**
 * Contrato da LISTA (F6.2/F6.3, D361 Adendo 17/09) — agregado, SEM NENHUM turno individual.
 * Espelha `AnaCareListProvider`/`AnaCareListPatient` de `worker-functions/.../domain/
 * AnaCareShift.ts` (backend real desta branch). `providers` continua array (não só um número)
 * para o filtro "Todos los prestadores" e o dropdown do front seguirem funcionando sem reescrita
 * — só `provider.shifts` some.
 *
 * ⚠️ NÃO confundir com `AnaCarePatient`/`AnaCareProvider` (acima): aqueles são o DETALHE (por
 * turno, ao vivo em `getPatientMonth`); estes são a LISTA (agregado, `getMonthSnapshot`). Antes
 * desta fase eram o MESMO tipo — a separação é a F6.3 (ver `selectors.ts` cabeçalho).
 */
export interface AnaCareListProvider {
  anaCareId: string;
  linked: boolean;
  name?: string;
}

export interface AnaCareListPatient {
  anaCareId: string;
  name?: string;
  /** D349 item 2 — paciente permanece SEMPRE sem vínculo, bloqueado. */
  linked: false;
  providers: AnaCareListProvider[];
  providersCount: number;
  shiftsCount: number;
  /** Modo `zero` de `totalHours` (front) — soma sozinha, já pronta (backend agrega). */
  hoursActualSum: number;
  /** Somado a `hoursActualSum` cobre o modo `'scheduled'` — nunca isolado, nunca somado ao modo `zero`. */
  hoursScheduledSumMissingActual: number;
  /** `COUNT` por status em `shift_hours_validation` (GROUP BY) — nunca mais o join 1:1 por turno. */
  validated: number;
  contested: number;
  originSinCheckin: number;
  originWebAdmin: number;
  originApp: number;
}

/** Forma do agregado "contagem por origem" — calculado em `selectors.ts`, nunca guardado à mão. */
export interface AnaCareOriginCounts {
  sinCheckin: number;
  webAdmin: number;
  app: number;
}

/**
 * Item 3 (revisão de PR): distingue "retrato NUNCA sincronizado" de "sincronizou, mas ficou
 * velho" — `stale` sozinho colapsava os dois e a tela mostrava sempre "há mais de 24 horas",
 * falso quando o sync nunca rodou.
 *
 * F2 (change `anacare-horas-conclusao-de-corrida`, migration 457) — 2 estados NOVOS, calculados
 * SÓ no backend (`AnaCareHoursMapper.computeSnapshotState`, worker-functions) a partir da
 * conclusão da corrida (`anacare_sync_run.status`/contagens) — este arquivo só espelha o tipo,
 * NUNCA recalcula:
 *   - `desconhecido` — o sync gravou esse mês antes de o sistema registrar conclusão (linhas de
 *     agosto/setembro pré-existentes). Não afirma completo nem incompleto.
 *   - `parcial` — a corrida NÃO terminou (aba fechada no meio, ou falhou) — mês pode ter reservas
 *     não visitadas.
 */
export type AnaCareSnapshotState = 'nao_construido' | 'desconhecido' | 'parcial' | 'velho' | 'fresco';

/**
 * Contrato da rota `GET /months/:month` — a LISTA. `patients` é o agregado (`AnaCareListPatient`,
 * F6.2/F6.3), nunca o array de turnos. Ver `AnaCareHoursPatientSnapshot` para o wrapper "de 1
 * paciente só" que o DETALHE monta (mesmo formato de campos de topo, `patients` com turnos).
 */
export interface AnaCareMonthSnapshot {
  /** ↔ `anacare_shift.period_month` (1º dia do mês) — aqui YYYY-MM. */
  month: string;
  /** Não tem coluna própria — derivado de `anacare_shift.fetched_at` mais recente do mês. */
  updatedAt: string;
  /** true = retrato com mais de 24h (derivado de `fetched_at`), ações de validar ficam desabilitadas. */
  stale: boolean;
  /** Ver `AnaCareSnapshotState` — granularidade que `stale` sozinho não carrega. */
  snapshotState: AnaCareSnapshotState;
  /** "disjuntor" — sincronização falhando repetidamente, proteção de carga ativa (estado do job noturno, não é coluna). */
  circuitBreakerOpen: boolean;
  /** F6.3: pacientes AGREGADOS (sem turno individual) — ver `AnaCareListPatient`. */
  patients: AnaCareListPatient[];
  /**
   * F2 (migration 457) — só presentes quando `snapshotState==='parcial'` E o sync já gravou as
   * duas contagens (nunca `0` fingido para "sem dado"). Ausentes em qualquer outro estado.
   */
  reservationsTotal?: number;
  reservationsDone?: number;
}

/**
 * O "`AnaCareMonthSnapshot` de 1 paciente só" que `useAnaCareHoursPatient` monta para reusar
 * `AnaCareHoursDetailPage` (que agrupa por dia via `selectors.ts`, precisa dos turnos). MESMOS
 * campos de topo do snapshot da lista, mas `patients` é `AnaCarePatient[]` (DETALHE, com turnos) —
 * nunca `AnaCareListPatient[]`. Extraído desta fase (F6.3): antes, os dois usavam o MESMO tipo
 * `AnaCareMonthSnapshot`, e a separação de contrato da lista (sem turnos) teria quebrado o
 * detalhe se continuassem compartilhando o tipo.
 */
export interface AnaCareHoursPatientSnapshot {
  month: string;
  updatedAt: string;
  stale: boolean;
  snapshotState: AnaCareSnapshotState;
  circuitBreakerOpen: boolean;
  patients: AnaCarePatient[];
  /** F2 (migration 457) — mesmo campo/mesma regra de `AnaCareMonthSnapshot`, ver ali. */
  reservationsTotal?: number;
  reservationsDone?: number;
}

// ── Comandos (payload de escrita) ───────────────────────────────────────────
// Espelham as colunas que `shift_hours_validation` exige em cada transição
// (pendente→validado, pendente→contestado, contestado→validado). Quem validou é a SESSÃO
// autenticada no backend — nenhum comando carrega validador (contrato HTTP fixo da fase 1).

/** Comando: validar 1 turno. ↔ grava `status='validado'`, `approved_hours`, `validated_by` (da sessão), `validated_at`. */
export interface ValidateShiftCommand {
  shiftId: string;
}

/** Comando: validar em lote — mesma escrita do comando único, repetida por turno da lista. */
export interface ValidateBatchCommand {
  shiftIds: string[];
}

/**
 * Comando: contestar 1 turno. ↔ grava `status='contestado'`, `reason` (NOT NULL, CHECK — 1.5b,
 * D344), `note_encrypted` (opcional, cifrado com KMS no backend).
 */
export interface ContestShiftCommand {
  shiftId: string;
  reason: ContestReason;
  note?: string;
}

/**
 * Estado do retrato — espelha `AnaCareMonthSnapshot.updatedAt/stale/snapshotState/circuitBreakerOpen`
 * como consulta isolada (útil pro banner sem carregar o mês inteiro). `snapshotState` carrega a
 * MESMA granularidade do snapshot completo (item 3) — antes deste campo, `useAnaCareHoursPatient`
 * tinha de APROXIMAR `stale ? 'velho' : 'fresco'`, colapsando "nunca construído" em "velho" e
 * mostrando ao operador uma mensagem falsa ("mais de 24 horas" quando o sync nunca rodou).
 */
export interface AnaCareRetratoStatus {
  updatedAt: string;
  stale: boolean;
  snapshotState: AnaCareSnapshotState;
  circuitBreakerOpen: boolean;
  /** F2 (migration 457) — mesmo campo/mesma regra de `AnaCareMonthSnapshot`, ver ali. */
  reservationsTotal?: number;
  reservationsDone?: number;
}

/**
 * Comando: dispara UMA RODADA do sync manual (F6.4, botão "Sincronizar" da lista). ↔
 * `POST /api/admin/anacare-hours/sync`, corpo `{month?, cursor?, budgetMs?}` — NUNCA
 * `runStartedAt` (D364: o carimbo da corrida é resolvido pelo SERVIDOR, não entra na rota). O laço
 * de várias rodadas até `nextCursor === null` é do CLIENTE (`useAnaCareHoursSync.ts`), nunca deste
 * comando isolado.
 */
export interface TriggerSyncCommand {
  month: string;
  cursor?: number | null;
  budgetMs?: number;
}

/**
 * Resposta de UMA rodada do sync — espelha o outcome de `AnaCareHoursSyncRunner` (backend).
 * `nextCursor === null` significa que a rodada TERMINOU o mês inteiro; qualquer número significa
 * CONTINUAR o laço reenviando esse valor como `cursor` na próxima chamada.
 */
export interface TriggerSyncResult {
  success: boolean;
  deduped: boolean;
  shiftsRead: number;
  reservationsProcessed: number;
  shiftsWritten: number;
  nextCursor: number | null;
  runStartedAt: string;
  /**
   * change `anacare-horas-feedback-visual-sync` (F2) — `AnaCareHoursSyncController.trigger` já
   * devolve estes dois campos no corpo do `POST /sync` (`AnaCareHoursSyncController.ts:156,170`,
   * comentário "expostos para o navegador poder mostrar progresso"); até aqui o cliente não os
   * tipava nem os lia. `reservationsTotal`/`reservationsDone` são o TOTAL/ACUMULADO da CORRIDA
   * inteira (não o delta desta rodada, que é `reservationsProcessed`) — cada rodada devolve o
   * índice absoluto já percorrido, somando rodadas anteriores retomadas por cursor
   * (`AnaCareHoursSyncRunner.reservationsDone`, ver comentário lá). `useAnaCareHoursSync.ts`
   * SOBRESCREVE (nunca soma) esses dois valores a cada rodada.
   */
  reservationsTotal: number;
  reservationsDone: number;
  shiftsSkippedNoProvider: number;
  shiftsSkippedNoPatient: number;
}
