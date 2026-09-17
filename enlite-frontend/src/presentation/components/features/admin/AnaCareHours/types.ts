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
  /** ↔ `anacare_shift.worker_id IS NOT NULL` (FK resolvida). */
  linked: boolean;
  /** Vem do vínculo (`workers`), nunca do retrato — sem `nurse_name_cache` (decisão do Gabriel, 15/09). Só existe se `linked === true` E o ator tem `worker_contact:read`. */
  name?: string;
  shifts: AnaCareShift[];
}

export interface AnaCarePatient {
  /** ↔ `anacare_shift.ana_care_patient_id`. */
  anaCareId: string;
  /** ↔ `anacare_shift.patient_id IS NOT NULL`. */
  linked: boolean;
  /** Vem do vínculo (`patients`), nunca do retrato. Só existe se `linked === true` E o ator tem `patient_identity:read`. */
  name?: string;
  providers: AnaCareProvider[];
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
 */
export type AnaCareSnapshotState = 'nao_construido' | 'velho' | 'fresco';

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
  patients: AnaCarePatient[];
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

/** Estado do retrato — espelha `AnaCareMonthSnapshot.updatedAt/stale/circuitBreakerOpen` como consulta isolada (útil pro banner sem carregar o mês inteiro). */
export interface AnaCareRetratoStatus {
  updatedAt: string;
  stale: boolean;
  circuitBreakerOpen: boolean;
}
