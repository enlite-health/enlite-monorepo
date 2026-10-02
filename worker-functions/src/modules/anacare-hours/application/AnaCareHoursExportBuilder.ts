/**
 * src/modules/anacare-hours/application/AnaCareHoursExportBuilder.ts
 *
 * Spec 032 (D11) — monta o xlsx do financeiro: 2 abas (`Sintético`/`Analítico`) de UM paciente num
 * período. Função PURA (sem I/O, relógio injetado): o Service já devolveu o `AnaCarePatient` sem
 * nota e sem documento, e o chamador decidiu o rótulo do paciente (nome ou `Sin vínculo · ID`).
 *
 * O arquivo é só es-AR (precedente `COLUMN_LABELS_ES` do `ExportWorkersUseCase`). NÃO carrega nome
 * de quem exportou, documento nem nota de contestação.
 *
 * `totalHours` (`selectors.ts`) é a DONA da regra de horas (D344): sem check-in soma 0h.
 */
import * as XLSX from 'xlsx';
import type { AnaCarePatient, AnaCareShift } from '../domain/AnaCareShift';
import { totalHours } from './selectors';

/** Fuso FIXO da fonte (UTC−06:00, sem DST) — o arquivo mostra o relógio do Ana Care, não o de quem abre. */
export const SOURCE_TIME_ZONE = 'Etc/GMT+6';
const ISSUED_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export const SHEET_SINTETICO = 'Sintético';
export const SHEET_ANALITICO = 'Analítico';
export const NO_SHIFTS_MESSAGE = 'Sin turnos en el período';
export const TOTAL_LABEL = 'Total';

export const SINTETICO_COLUMNS = ['Prestador', 'Turnos', 'Horas totales', 'Horas validadas', 'Horas no validadas'] as const;
export const ANALITICO_COLUMNS = ['Fecha', 'Prestador', 'Inicio previsto', 'Fin previsto', 'Check-in', 'Check-out', 'Origen', 'Horas', 'Estado'] as const;

const ORIGIN_LABEL: Record<AnaCareShift['origin'], string> = {
  app: 'App',
  web_admin: 'Web admin',
  sin_checkin: 'Sin check-in',
};

export interface BuildAnaCareHoursWorkbookInput {
  /** `null` = nenhum turno no período. */
  patient: AnaCarePatient | null;
  /** Rótulo já decidido pelo chamador (nome com `patient_identity:read`; senão `Sin vínculo · ID <id>`). */
  patientLabel: string;
  /** `YYYY-MM-DD`, inclusivo. */
  desde: string;
  hasta: string;
  /** Instante da emissão (injetado para o teste). */
  now: Date;
}

type Cell = string | number;

const clockFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: SOURCE_TIME_ZONE });
const sourceDateFormatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: SOURCE_TIME_ZONE });
const issuedFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: ISSUED_TIME_ZONE,
});

/** Horas em 2 casas (a fonte já entrega em 2) — tira o ruído de ponto flutuante das somas. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function providerLabel(p: { anaCareId: string; name?: string }): string {
  return p.name ? p.name : `Sin vínculo · ID ${p.anaCareId}`;
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`. */
function dmy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * `HH:MM` no relógio da fonte; se o instante cai num dia DEPOIS do dia do turno (`shiftDate`, o dia
 * em que ele começa), acrescenta `(+1 día)` — o turno 22:00→10:00 mostra o fim no dia seguinte.
 */
function clock(iso: string | null | undefined, shiftDate: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = clockFormatter.format(d);
  return sourceDateFormatter.format(d) > shiftDate ? `${time} (+1 día)` : time;
}

function estadoOf(s: AnaCareShift): string {
  if (s.status === 'validado') return 'Validado';
  if (s.status === 'contestado') return 'Contestado';
  if (s.origin === 'sin_checkin') return 'Sin check-in';
  return 'Pendiente';
}

function header(title: string, input: BuildAnaCareHoursWorkbookInput): Cell[][] {
  return [
    ['Paciente', input.patientLabel],
    ['Período', `${dmy(input.desde)} → ${dmy(input.hasta)}`],
    ['Emitido (Buenos Aires)', issuedFormatter.format(input.now).replace(',', '')],
    ['Horarios en el reloj de la fuente (UTC−06:00)'],
    ['Documento confidencial'],
    [title],
  ];
}

interface ShiftRow {
  shift: AnaCareShift;
  provider: string;
}

function collectRows(patient: AnaCarePatient | null): ShiftRow[] {
  if (!patient) return [];
  const rows: ShiftRow[] = [];
  for (const p of patient.providers) {
    const label = providerLabel(p);
    for (const shift of p.shifts) rows.push({ shift, provider: label });
  }
  return rows;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sheetOf(rows: Cell[][], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

function buildSintetico(input: BuildAnaCareHoursWorkbookInput, rows: ShiftRow[]): XLSX.WorkSheet {
  const byProvider = new Map<string, AnaCareShift[]>();
  for (const r of rows) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r.shift]);
  const out: Cell[][] = [...header('Sintético', input), [...SINTETICO_COLUMNS]];
  if (rows.length === 0) out.push([NO_SHIFTS_MESSAGE]);
  for (const provider of [...byProvider.keys()].sort(cmp)) {
    const shifts = byProvider.get(provider)!;
    out.push([
      provider,
      shifts.length,
      round2(totalHours(shifts)),
      round2(totalHours(shifts.filter((s) => s.status === 'validado'))),
      round2(totalHours(shifts.filter((s) => s.status !== 'validado'))),
    ]);
  }
  const all = rows.map((r) => r.shift);
  out.push([
    TOTAL_LABEL,
    all.length,
    round2(totalHours(all)),
    round2(totalHours(all.filter((s) => s.status === 'validado'))),
    round2(totalHours(all.filter((s) => s.status !== 'validado'))),
  ]);
  return sheetOf(out, [42, 10, 15, 17, 19]);
}

function buildAnalitico(input: BuildAnaCareHoursWorkbookInput, rows: ShiftRow[]): XLSX.WorkSheet {
  const sorted = [...rows].sort(
    (a, b) =>
      cmp(a.shift.date, b.shift.date) || cmp(a.provider, b.provider) || cmp(a.shift.scheduledStart, b.shift.scheduledStart) || cmp(a.shift.id, b.shift.id),
  );
  const out: Cell[][] = [...header('Analítico', input), [...ANALITICO_COLUMNS]];
  if (sorted.length === 0) out.push([NO_SHIFTS_MESSAGE]);
  for (const { shift: s, provider } of sorted) {
    out.push([
      dmy(s.date),
      provider,
      clock(s.scheduledStart, s.date),
      clock(s.scheduledEnd, s.date),
      clock(s.actualStart, s.date),
      clock(s.actualEnd, s.date),
      ORIGIN_LABEL[s.origin],
      round2(s.hoursActual ?? 0),
      estadoOf(s),
    ]);
  }
  out.push([TOTAL_LABEL, '', '', '', '', '', '', round2(totalHours(sorted.map((r) => r.shift))), '']);
  return sheetOf(out, [12, 42, 18, 18, 18, 18, 14, 9, 14]);
}

export function buildAnaCareHoursWorkbook(input: BuildAnaCareHoursWorkbookInput): Buffer {
  const rows = collectRows(input.patient);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSintetico(input, rows), SHEET_SINTETICO);
  XLSX.utils.book_append_sheet(wb, buildAnalitico(input, rows), SHEET_ANALITICO);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
