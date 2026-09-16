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

/** Sem nome resolvido, mostra só o ID cru — NUNCA um rótulo negativo tipo "Sin vínculo" (decisão de 16/09). */
export function providerDisplayName(provider: AnaCareProvider): string {
  return provider.name ?? provider.anaCareId;
}

/** Paciente nunca tem nome (reconciliação fora de escopo) — sempre o ID cru. */
export function patientDisplayName(patient: AnaCarePatient): string {
  return patient.anaCareId;
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
      // Paciente nunca tem nome (fora de escopo) — a busca é sempre por ID.
      if (!patient.anaCareId.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
