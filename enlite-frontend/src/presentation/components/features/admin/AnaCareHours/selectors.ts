/**
 * Único dono dos conceitos DERIVADOS desta feature (horas totais, progresso de validação,
 * contagem por origem, filtro cliente). Lista e detalhe leem daqui — nunca recalculam à mão em
 * componente, pra não repetir o erro de "completo" com 7 cópias divergentes (ver memória
 * conceito-derivado-tem-um-dono). Portado sem mudança de comportamento do protótipo em
 * `repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHours/selectors.ts` — só ganhou
 * `filterPatients`, extraído para ser reusado pelo `FakeAnaCareHoursService` E pelo
 * `AnaCareHoursHttpService` (o filtro roda no CLIENTE nos dois, nunca manda nome como query
 * string pro backend — regra dura de privacidade do brief).
 */
import type { AnaCareMonthSnapshot, AnaCareOriginCounts, AnaCareProvider, AnaCareShift, AnaCarePatient } from './types';

/**
 * Mês padrão da tela (decisão do Gabriel, 16/09): o MÊS ANTERIOR ao atual, não o mês corrente —
 * medido que agosto tem turnos finalizados e setembro quase não (retrato ainda incompleto no mês
 * em curso). Único dono do cálculo — `AnaCareHoursPatientPage` e `AnaCareHoursListContainer` leem
 * daqui, nada de `'2026-08'` cravado em código.
 */
export function previousMonthIso(referenceDate: Date = new Date()): string {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth(); // 0-based; month-1 já é o mês anterior em 0-based do mês atual
  const previous = new Date(Date.UTC(year, month, 1));
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * D344 (`docs/decisoes.md`): "turno sem check-in soma 0 h no total exibido" — o modo `'zero'` é o
 * ÚNICO usado na tela real. `'scheduled'` (soma a hora PREVISTA) existia no protótipo como
 * alternativa de depuração de um harness que não foi portado (task: NÃO portar
 * `preview-anacare-horas.*`) — o tipo/parâmetro fica aqui só porque `blockReason`/`shiftHours`
 * continuam puros e testáveis com os dois modos; nenhum container real passa `'scheduled'`.
 */
export type SinCheckinHoursMode = 'zero' | 'scheduled';

export function shiftHours(shift: AnaCareShift, sinCheckinHoursMode: SinCheckinHoursMode = 'zero'): number {
  if (shift.hoursActual !== null) return shift.hoursActual;
  return sinCheckinHoursMode === 'scheduled' ? shift.hoursScheduled : 0;
}

export function allShiftsOf(patient: AnaCarePatient): AnaCareShift[] {
  return patient.providers.flatMap((p) => p.shifts);
}

export function totalHours(shifts: AnaCareShift[], sinCheckinHoursMode: SinCheckinHoursMode = 'zero'): number {
  return shifts.reduce((acc, s) => acc + shiftHours(s, sinCheckinHoursMode), 0);
}

export interface ValidationProgress {
  total: number;
  validated: number;
  contested: number;
  pending: number;
  /** 0-100, arredondado. */
  percentage: number;
}

export function validationProgress(shifts: AnaCareShift[]): ValidationProgress {
  const total = shifts.length;
  const validated = shifts.filter((s) => s.status === 'validado').length;
  const contested = shifts.filter((s) => s.status === 'contestado').length;
  const pending = shifts.filter((s) => s.status === 'pendiente').length;
  const percentage = total === 0 ? 0 : Math.round((validated / total) * 100);
  return { total, validated, contested, pending, percentage };
}

export function originCounts(shifts: AnaCareShift[]): AnaCareOriginCounts {
  return {
    sinCheckin: shifts.filter((s) => s.origin === 'sin_checkin').length,
    webAdmin: shifts.filter((s) => s.origin === 'web_admin').length,
    app: shifts.filter((s) => s.origin === 'app').length,
  };
}

export function providerDisplayName(provider: AnaCareProvider): string {
  return provider.linked && provider.name ? provider.name : `Sin vínculo · ID ${provider.anaCareId}`;
}

export function patientDisplayName(patient: AnaCarePatient): string {
  return patient.linked && patient.name ? patient.name : `Sin vínculo · ID ${patient.anaCareId}`;
}

export function pendingShiftsOf(provider: AnaCareProvider): AnaCareShift[] {
  return provider.shifts.filter((s) => s.status === 'pendiente');
}

/** Turnos com "Sin check-in" entre os pendentes de um lote — informação exibida no modal de lote. */
export function pendingOriginBreakdown(shifts: AnaCareShift[]): { sinCheckin: number; webAdmin: number } {
  return {
    sinCheckin: shifts.filter((s) => s.origin === 'sin_checkin').length,
    webAdmin: shifts.filter((s) => s.origin === 'web_admin').length,
  };
}

/** Validado CONGELA (regra travada) — pendente e contestado seguem selecionáveis pelo checkbox. */
export function isShiftSelectable(shift: AnaCareShift): boolean {
  return shift.status !== 'validado';
}

/** Resumo da SELEÇÃO (barra fixa do rodapé) — dono único, nunca somado à mão no componente. */
export interface SelectionSummary {
  count: number;
  hours: number;
  sinCheckinCount: number;
}

export function selectionSummary(shifts: AnaCareShift[], sinCheckinHoursMode: SinCheckinHoursMode = 'zero'): SelectionSummary {
  return {
    count: shifts.length,
    hours: totalHours(shifts, sinCheckinHoursMode),
    sinCheckinCount: shifts.filter((s) => s.origin === 'sin_checkin').length,
  };
}

/**
 * Estado do checkbox de CABEÇALHO do prestador — reflete só os turnos PENDENTES selecionados
 * (contestados nunca entram nessa conta: são marcados individualmente, regra travada do brief).
 */
export type PendingSelectionState = 'all' | 'none' | 'partial';

export function providerPendingSelectionState(provider: AnaCareProvider, selectedShiftIds: ReadonlySet<string>): PendingSelectionState {
  const pending = pendingShiftsOf(provider);
  if (pending.length === 0) return 'none';
  const selectedCount = pending.filter((s) => selectedShiftIds.has(s.id)).length;
  if (selectedCount === 0) return 'none';
  if (selectedCount === pending.length) return 'all';
  return 'partial';
}

/**
 * Texto do motivo de bloqueio quando o retrato está desatualizado. `'largo'` é a frase completa
 * (usada SEMPRE no banner grande do topo — nunca muda); `'corto'` é o texto fixo por prestador,
 * D344: "Validación bloqueada: retrato desactualizado" — a tela real (`AnaCareHoursDetailPage`)
 * usa `'corto'` como padrão para o motivo POR PRESTADOR (1.5a); esta função em si mantém `'largo'`
 * como default próprio, pra continuar pura/testável nos dois modos sem decidir pelo caller.
 */
export type BlockReasonMode = 'largo' | 'corto';

export function blockReason(
  snapshot: Pick<AnaCareMonthSnapshot, 'stale' | 'circuitBreakerOpen'>,
  mode: BlockReasonMode = 'largo',
): string | undefined {
  if (!snapshot.stale && !snapshot.circuitBreakerOpen) return undefined;
  if (mode === 'corto') return 'retrato desactualizado';
  return snapshot.circuitBreakerOpen
    ? 'Sincronización con Ana Care fallando — protección de carga activada (disjuntor). Validación deshabilitada hasta el próximo retrato.'
    : 'Retrato con más de 24 horas — validación deshabilitada hasta actualizar.';
}

/** Filtros do V1 — paciente (texto livre) e prestador (id exato) — sempre aplicados NO CLIENTE, nunca mandados ao backend como query de nome (PII em URL/log). */
export interface AnaCareHoursClientFilters {
  patientSearch?: string;
  providerId?: string;
}

/**
 * Filtra a lista de pacientes de um snapshot — dono único do critério, usado pelo
 * `FakeAnaCareHoursService` (harness/testes) e pelo `AnaCareHoursHttpService` (produção): o
 * backend devolve o mês INTEIRO, o filtro roda aqui.
 */
export function filterPatients(patients: AnaCarePatient[], filters?: AnaCareHoursClientFilters): AnaCarePatient[] {
  if (!filters || (!filters.patientSearch && !filters.providerId)) return patients;
  return patients.filter((patient) => {
    if (filters.providerId && !patient.providers.some((p) => p.anaCareId === filters.providerId)) {
      return false;
    }
    if (filters.patientSearch?.trim()) {
      const q = filters.patientSearch.trim().toLowerCase();
      const label = (patient.linked && patient.name ? patient.name : patient.anaCareId).toLowerCase();
      if (!label.includes(q) && !patient.anaCareId.includes(q)) return false;
    }
    return true;
  });
}

// ── Eixo por DIA (decisão do Gabriel, 16/09) — porte de `repos/infra/_worktrees/proto-anacare-
// horas/.../AnaCareHours/selectors.ts` sem mudança de comportamento. O detalhe do paciente passa
// a agrupar por DIA (não por prestador) — dentro de cada dia, os prestadores que atuaram
// aparecem lado a lado. Regras travadas preservadas: validação continua por TURNO, dia sem
// nenhum turno não aparece, navegação é semana a semana e roda EM MEMÓRIA (o mês inteiro já veio
// numa chamada só — ver `useAnaCareHoursPatient`).

/** Um turno com o prestador já resolvido — forma intermediária pra agrupar por dia sem perder de quem é o turno. */
export interface ShiftWithProvider {
  shift: AnaCareShift;
  provider: AnaCareProvider;
}

export function allShiftEntriesOf(patient: AnaCarePatient): ShiftWithProvider[] {
  return patient.providers.flatMap((provider) => provider.shifts.map((shift) => ({ shift, provider })));
}

/** Segunda-feira (ISO weekday 1) da semana que contém `dateIso` — string YYYY-MM-DD. */
export function startOfWeekMonday(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoWeekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // domingo=0 → 7
  date.setUTCDate(date.getUTCDate() - (isoWeekday - 1));
  return date.toISOString().slice(0, 10);
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Um grupo de dia — só existe se houver ao menos 1 turno nele (regra travada: dia vazio não aparece). */
export interface DayGroupData {
  date: string;
  entries: ShiftWithProvider[];
}

/**
 * Agrupa os turnos do paciente que caem dentro da semana [weekStart, weekStart+6], por dia,
 * em ordem crescente. Dias sem nenhum turno simplesmente não geram grupo — nunca um placeholder.
 */
export function groupShiftsByDayInWeek(patient: AnaCarePatient, weekStart: string): DayGroupData[] {
  const weekEnd = addDaysIso(weekStart, 6);
  const entries = allShiftEntriesOf(patient).filter((e) => e.shift.date >= weekStart && e.shift.date <= weekEnd);
  const byDate = new Map<string, ShiftWithProvider[]>();
  for (const entry of entries) {
    const list = byDate.get(entry.shift.date) ?? [];
    list.push(entry);
    byDate.set(entry.shift.date, list);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, es]) => ({ date, entries: es }));
}

/** Estado de seleção "pendentes" de um GRUPO qualquer de turnos (dia, em vez de prestador). */
export function pendingSelectionStateOf(shifts: AnaCareShift[], selectedShiftIds: ReadonlySet<string>): PendingSelectionState {
  const pending = shifts.filter((s) => s.status === 'pendiente');
  if (pending.length === 0) return 'none';
  const selectedCount = pending.filter((s) => selectedShiftIds.has(s.id)).length;
  if (selectedCount === 0) return 'none';
  if (selectedCount === pending.length) return 'all';
  return 'partial';
}

/**
 * Resumo de horas do CABEÇALHO do dia: total do dia e quanto disso já está validado — dono único
 * do cálculo, o `DayGroup` só formata. `allValidated` também serve pro botão "Enviar": só habilita
 * quando TODOS os turnos do dia (não só os selecionados) estão validados. Dia sem turno nunca
 * chega aqui (regra travada: dia vazio não gera grupo).
 */
export interface DayHoursSummary {
  total: number;
  validated: number;
  allValidated: boolean;
}

export function dayHoursSummary(shifts: AnaCareShift[], sinCheckinHoursMode: SinCheckinHoursMode = 'zero'): DayHoursSummary {
  const validatedShifts = shifts.filter((s) => s.status === 'validado');
  return {
    total: totalHours(shifts, sinCheckinHoursMode),
    validated: totalHours(validatedShifts, sinCheckinHoursMode),
    allValidated: shifts.length > 0 && validatedShifts.length === shifts.length,
  };
}
