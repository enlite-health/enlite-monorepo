/**
 * admissionSchedulingConfig — os três parâmetros de agendamento de admissão que
 * mudam com a change `agenda-admissao-atendentes`, todos lidos do ambiente A
 * CADA CHAMADA (nunca no import), para que teste e runtime enxerguem a mesma
 * fonte e nada fique preso ao boot.
 *
 * ⚠️ A flag governa MODO, não só fonte de dado. Merge tem que sair NEUTRO em
 * produção (o merge no `main` deploya sozinho, sem gate manual), então com a
 * flag ausente tudo — inclusive duração e antecedência — precisa ficar
 * idêntico ao que está no ar hoje:
 *
 *   flag OFF (hoje):  disponibilidade = agenda de admissão do país (capacidade
 *                     1), slots de 45min, antecedência de 2h.
 *   flag ON  (novo):  disponibilidade = união das agendas pessoais das
 *                     atendentes ativas do país, slots de 60min, antecedência
 *                     de 4h.
 *
 * As duas grandezas seguem sobrescrevíveis por env em qualquer um dos modos
 * (o spec exige a antecedência configurável por ambiente sem mexer em código).
 */

/** Duração do slot, em minutos, por modo. */
const SLOT_MINUTES_ROSTER = 60;
const SLOT_MINUTES_LEGACY = 45;

/** Antecedência mínima entre "agora" e o início da entrevista, em minutos. */
const MIN_LEAD_MINUTES_ROSTER = 240; // 4h — pedido da Ana (organizar quem cobre)
const MIN_LEAD_MINUTES_LEGACY = 120; // 2h — o que está no ar hoje

/**
 * Roster de atendentes ligado? Kill-switch do go-live (D2): permite mergear
 * neutro e popular `interview_hosts` com calma antes de ligar.
 *
 * ⚠️ A virada é EDITANDO `ADMISSION_HOST_ROSTER_ENABLED` no
 * `.github/workflows/backend-prd.yml`, **não** por `gcloud --update-env-vars`.
 * A chave passou a ser declarada no workflow, e o deploy aplica a lista com
 * semântica de merge: um flip feito por `gcloud` sobreviveria até o próximo
 * merge no `main` e então seria reafirmado como `false` em silêncio — com
 * atendentes já atribuídas e pacientes já agendados. Editar o YAML deixa a
 * virada num commit revisável, e o rollback é o commit inverso.
 */
export function isHostRosterEnabled(): boolean {
  return process.env.ADMISSION_HOST_ROSTER_ENABLED === 'true';
}

/**
 * Inteiro positivo a partir de env; qualquer coisa que não seja inteiro > 0
 * (ausente, vazio, `abc`, `0`, `-5`, `45.5`) cai no default do modo — parâmetro
 * de agenda mal digitado não pode virar grade de horários silenciosamente
 * quebrada.
 */
function positiveIntFromEnv(varName: string, fallback: number): number {
  const raw = process.env[varName];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Duração da entrevista, em minutos (`ADMISSION_SLOT_MINUTES` sobrescreve). */
export function resolveSlotMinutes(): number {
  return positiveIntFromEnv(
    'ADMISSION_SLOT_MINUTES',
    isHostRosterEnabled() ? SLOT_MINUTES_ROSTER : SLOT_MINUTES_LEGACY,
  );
}

/** Antecedência mínima, em minutos (`ADMISSION_MIN_LEAD_MINUTES` sobrescreve). */
export function resolveMinLeadMinutes(): number {
  return positiveIntFromEnv(
    'ADMISSION_MIN_LEAD_MINUTES',
    isHostRosterEnabled() ? MIN_LEAD_MINUTES_ROSTER : MIN_LEAD_MINUTES_LEGACY,
  );
}
