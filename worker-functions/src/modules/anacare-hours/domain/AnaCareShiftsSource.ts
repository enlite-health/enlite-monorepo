/**
 * src/modules/anacare-hours/domain/AnaCareShiftsSource.ts
 *
 * Porta de leitura dos turnos do Ana Care (spec §Contrato de dados). Fase 1 usa só o adapter FALSO
 * (`FakeAnaCareShiftsSource`) — nenhuma implementação real (sessão HTTP contra o Ana Care) entra
 * nesta fase; fases 2/4 estão sob PARE do lex (D344).
 */

export interface SourceShiftDTO {
  sourceShiftId: string;
  anaCarePatientId: string;
  anaCareNurseId: string;
  /** ISO 8601 (UTC), YYYY-MM-DD para o dia do turno. */
  date: string;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  /** 'app' | 'web_admin' | null — null = sem check-in. */
  checkinSource: 'app' | 'web_admin' | null;
  /** Horas decimais da fonte (duration_hours) — null quando não há check-in. */
  durationHours: number | null;
}

export interface ListShiftsParams {
  /** Mês no formato YYYY-MM. */
  month: string;
  patientId?: string;
}

/**
 * Porta enxuta (minimização na borda, spec §Minimização): nenhum campo de telefone, endereço,
 * geolocalização, pagamento, observação ou documento de identidade passa por aqui.
 */
export interface AnaCareShiftsSource {
  listShifts(params: ListShiftsParams): Promise<SourceShiftDTO[]>;
  /** Um turno por `sourceShiftId`, sem precisar do mês (validar/contestar não recebem mês no corpo). */
  getShift(sourceShiftId: string): Promise<SourceShiftDTO | null>;
}
