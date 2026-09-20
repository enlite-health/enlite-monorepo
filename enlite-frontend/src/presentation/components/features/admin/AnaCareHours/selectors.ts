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
 * Mês padrão da tela (decisão do Gabriel, 20/09 — substitui a decisão de 16/09 que usava o mês
 * ANTERIOR): o MÊS CORRENTE. Único dono do cálculo — `AnaCareHoursPatientPage` e
 * `AnaCareHoursListContainer` leem daqui, nada de `'2026-09'` cravado em código.
 */
export function currentMonthIso(referenceDate: Date = new Date()): string {
  return `${referenceDate.getUTCFullYear()}-${String(referenceDate.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Lista crescente de `YYYY-MM`, do piso (`floorMonthIso`, default `'2026-08'` — primeiro mês com
 * dado real do Ana Care) até o mês CORRENTE de `referenceDate`, inclusive — alimenta o seletor de
 * mês da lista (`AnaCareHoursListPage`) sem precisar crescer a lista à mão a cada mês novo
 * (decisão do Gabriel, 20/09). Se o piso for posterior ao mês corrente (relógio do ambiente
 * atrasado, ou piso mal configurado), devolve só o piso — nunca lista vazia, pra não deixar o
 * seletor sem opção nenhuma.
 */
export function monthOptionsUntilNow(floorMonthIso = '2026-08', referenceDate: Date = new Date()): string[] {
  const current = currentMonthIso(referenceDate);
  const [floorYear, floorMonth] = floorMonthIso.split('-').map(Number);
  const [currentYear, currentMonth] = current.split('-').map(Number);
  const floorIndex = floorYear * 12 + (floorMonth - 1);
  const currentIndex = currentYear * 12 + (currentMonth - 1);
  if (floorIndex > currentIndex) return [floorMonthIso];
  const months: string[] = [];
  for (let index = floorIndex; index <= currentIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    months.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return months;
}

/**
 * Rótulo visível do mês no seletor da lista — formato TEM de ficar idêntico ao que antes vinha
 * fixo de `admin.anacareHours.months.<YYYY-MM>` no i18n (`"Agosto 2026"`, `"Septiembre 2026"`,
 * `"Setembro 2026"`): nome do mês pelo `Intl.DateTimeFormat(locale, { month: 'long' })`, primeira
 * letra maiúscula, espaço, ano. `timeZone: 'UTC'` evita que o fuso do navegador vire o mês (ex.:
 * `2026-09-01T00:00:00` local negativo cairia em agosto).
 */
export function formatMonthLabel(monthIso: string, locale: string): string {
  const [year, month] = monthIso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
  const capitalized = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  return `${capitalized} ${year}`;
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

/**
 * Item 1 (nome e sobrenome, decisão do Gabriel 17/09): o nome vem da FONTE (payload do turno), não
 * mais gated por `linked` — `linked` continua significando "casa com um worker/paciente nosso" e é
 * exibido/usado à parte (nunca decidiu se o NOME aparece). O fallback `Sin vínculo · ID X`
 * permanece honesto para quando a fonte não manda nome (turno sem nome existe).
 *
 * Assinatura ESTREITA (só `anaCareId`/`name`) de propósito (F6.3): serve tanto `AnaCareProvider`
 * (DETALHE, com turnos) quanto `AnaCareListProvider` (LISTA, agregado, sem turnos) — mesma função,
 * mesmo comportamento, sem duplicar. Nenhuma lógica mudou, só o tipo aceito ficou mais largo.
 */
export function providerDisplayName(provider: { anaCareId: string; name?: string }): string {
  return provider.name ? provider.name : `Sin vínculo · ID ${provider.anaCareId}`;
}

/** Mesma nota de `providerDisplayName` — serve `AnaCarePatient` (DETALHE) e `AnaCareListPatient` (LISTA). */
export function patientDisplayName(patient: { anaCareId: string; name?: string }): string {
  return patient.name ? patient.name : `Sin vínculo · ID ${patient.anaCareId}`;
}

/**
 * Item 2 (conferência de horas, 17/09): a fonte manda os timestamps com offset FIXO `-06:00`
 * (fuso da plataforma do Ana Care, medido: 100% dos turnos amostrados), e a tela existia para
 * CONFERIR contra o Ana Care — o relógio de parede exibido tem de ser o MESMO que a fonte envia,
 * nunca o fuso do navegador (`new Date(...).toLocaleTimeString()` erra isso, converte pro fuso
 * local). `Etc/GMT+6` é a zona IANA equivalente a UTC-6 fixo, sem DST — funciona tanto para o
 * timestamp CRU vindo direto da fonte (string com `-06:00`, caminho DETALHE) quanto para um
 * round-trip por `timestamptz` no Postgres (caminho LISTA: o texto do offset pode virar `Z` na
 * serialização, mas o INSTANTE gravado é o mesmo) — `new Date(iso)` normaliza os dois formatos ao
 * mesmo instante UTC, e formatar com fuso FIXO devolve a mesma hora de parede nos dois casos.
 */
const SOURCE_TIME_ZONE = 'Etc/GMT+6';

const wallClockFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: SOURCE_TIME_ZONE,
});

const wallDateFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: SOURCE_TIME_ZONE,
});

/** `HH:MM` no fuso FIXO da fonte, ou `undefined` se `iso` vier vazio/nulo/inválido — nunca lança. */
export function formatSourceTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return wallClockFormatter.format(date);
}

/**
 * `YYYY-MM-DD` no fuso da FONTE — só para COMPARAR dias (turno cruzando meia-noite), nunca
 * exibido cru. Sem checagem de validade própria: o único chamador (`formatSourceRange`) só
 * invoca depois que `formatSourceTime` já validou o MESMO iso — duplicar o guard aqui seria
 * ramo morto, nunca exercitado.
 */
function sourceDayKey(iso: string): string {
  return wallDateFormatter.format(new Date(iso)); // en-CA formata YYYY-MM-DD.
}

/**
 * `HH:MM–HH:MM`, com `(+1)` quando o FIM cai em outro dia da fonte — medido: 46% dos turnos de
 * agosto cruzam a meia-noite (1.255 de 2.701), `20:00–08:00` sozinho é ambíguo. `—` quando falta
 * início ou fim (retrato sem o previsto gravado ainda, spec item 7 — nunca um horário inventado).
 */
export function formatSourceRange(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const start = formatSourceTime(startIso);
  const end = formatSourceTime(endIso);
  if (!start || !end) return '—';
  const crossesMidnight = sourceDayKey(endIso!) > sourceDayKey(startIso!);
  return crossesMidnight ? `${start}–${end} (+1)` : `${start}–${end}`;
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

/** Forma mínima que `filterPatients` precisa — satisfeita tanto por `AnaCarePatient` (DETALHE) quanto por `AnaCareListPatient` (LISTA, F6.3). */
interface FilterablePatient {
  anaCareId: string;
  linked: boolean;
  name?: string;
  providers: Array<{ anaCareId: string }>;
}

/**
 * Filtra a lista de pacientes de um snapshot — dono único do critério, usado pelo
 * `FakeAnaCareHoursService` (harness/testes, aplicado ANTES da agregação, sobre `AnaCarePatient[]`)
 * e pelo `AnaCareHoursHttpService` (produção, aplicado sobre `AnaCareListPatient[]` já agregado
 * pelo backend). Genérico (F6.3) para servir os dois sem duplicar — lógica intocada.
 */
export function filterPatients<T extends FilterablePatient>(patients: T[], filters?: AnaCareHoursClientFilters): T[] {
  if (!filters || (!filters.patientSearch && !filters.providerId)) return patients;
  return patients.filter((patient) => {
    if (filters.providerId && !patient.providers.some((p) => p.anaCareId === filters.providerId)) {
      return false;
    }
    if (filters.patientSearch?.trim()) {
      const q = filters.patientSearch.trim().toLowerCase();
      // Item 1 (decisão do Gabriel, 17/09, já aplicada em `patientDisplayName`): o nome vem da
      // FONTE, não mais gated por `linked` — `linked` do paciente da LISTA é SEMPRE `false`
      // (D349 item 2), então gatear por ele aqui fazia a busca por nome nunca casar contra o
      // agregado (F6.3 expôs o descompasso: antes o fixture de teste usava `linked: true`,
      // valor que o contrato real nunca manda). Mesma regra de `patientDisplayName`.
      const label = (patient.name ? patient.name : patient.anaCareId).toLowerCase();
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

/**
 * Motivo de bloqueio do botão "Enviar" (envio ao Axonico) — lista fechada, uma entrada por regra
 * de habilitação (decisão do Gabriel, 19/09). Mais de um pode estar presente ao mesmo tempo (ex.:
 * dia sem check-out E sem documento) — a tela mostra TODOS, nunca só o primeiro.
 */
export type AxonicoBlockReason = 'notValidated' | 'missingCheckInOut' | 'fractionalHours' | 'missingDocument';

export interface AxonicoDayEligibility {
  eligible: boolean;
  reasons: AxonicoBlockReason[];
}

/** Tolerância pra comparar `total` (soma de decimais) contra o inteiro mais próximo — nunca arredonda o valor enviado, só decide se ele JÁ é inteiro. */
const WHOLE_HOUR_EPSILON = 1e-6;

/**
 * As 4 condições do envio ao Axonico (decisão do Gabriel, 19/09, ver brief da tarefa):
 *  1. todos os turnos do dia VALIDADOS;
 *  2. todos os turnos do dia com check-in E check-out (`hoursActual !== null`) — turno sem par
 *     vale 0 h no total exibido (D344), então mandar o dia faturaria menos do que foi trabalhado;
 *  3. o total do dia é hora CHEIA (inteiro) — nunca arredondar;
 *  4. `documentNumber` do paciente presente.
 * Único dono do cálculo — `DayGroup` só lê `eligible`/`reasons` e formata. Independente de
 * `dayHoursSummary` (que serve o cabeçalho) porque as regras de elegibilidade do envio são mais
 * estritas: turno sem check-in aqui BLOQUEIA (`missingCheckInOut`), não só zera o total.
 */
export function axonicoDayEligibility(
  shifts: AnaCareShift[],
  documentNumber: string | undefined,
  sinCheckinHoursMode: SinCheckinHoursMode = 'zero',
): AxonicoDayEligibility {
  const reasons: AxonicoBlockReason[] = [];
  if (shifts.length === 0 || !shifts.every((s) => s.status === 'validado')) reasons.push('notValidated');
  if (!shifts.every((s) => s.hoursActual !== null)) reasons.push('missingCheckInOut');
  const total = totalHours(shifts, sinCheckinHoursMode);
  if (Math.abs(total - Math.round(total)) >= WHOLE_HOUR_EPSILON) reasons.push('fractionalHours');
  if (!documentNumber) reasons.push('missingDocument');
  return { eligible: reasons.length === 0, reasons };
}
