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
  /**
   * Afirmação da fonte de que o turno fechou. NÃO existe campo de horas trabalhadas na porta —
   * medido 17/09 contra a API real: o único campo de horas do Ana Care (`duration`) é o PREVISTO
   * (`scheduledEnd - scheduledStart`), preenchido mesmo sem check-in e mesmo turno não finalizado.
   * Hora trabalhada se deriva SEMPRE de `actualStart`/`actualEnd` (ver `AnaCareHoursMapper`), nunca
   * de um campo da fonte.
   */
  isFinalized: boolean;
}

export interface ListShiftsParams {
  /** Mês no formato YYYY-MM. */
  month: string;
  patientId?: string;
  /** Restringe a uma reserva/conta específica do Ana Care (mesmo número que a conta — F17). */
  reservationId?: string;
}

/** Estado do retrato — alimenta `AnaCareMonthSnapshot.stale`/`circuitBreakerOpen` e a recusa de escrita (spec "retrato desatualizado bloqueia a validação no serviço e na tela"). */
export interface AnaCareRetratoSourceStatus {
  stale: boolean;
  circuitBreakerOpen: boolean;
}

/**
 * Porta enxuta (minimização na borda, spec §Minimização): nenhum campo de telefone, endereço,
 * geolocalização, pagamento, observação ou documento de identidade passa por aqui.
 */
export interface AnaCareShiftsSource {
  listShifts(params: ListShiftsParams): Promise<SourceShiftDTO[]>;
  /** Um turno por `sourceShiftId`, sem precisar do mês (validar/contestar não recebem mês no corpo). */
  getShift(sourceShiftId: string): Promise<SourceShiftDTO | null>;
  /**
   * Estado do retrato: `stale` (job de sync falhou/atrasou) e `circuitBreakerOpen` (disjuntor
   * contra o Ana Care aberto). Fase 1 (adapter falso): sempre `{ stale: false,
   * circuitBreakerOpen: false }` — staleness real é job da fase 2/4 (sob PARE do lex).
   */
  getRetratoStatus(): Promise<AnaCareRetratoSourceStatus>;
}
