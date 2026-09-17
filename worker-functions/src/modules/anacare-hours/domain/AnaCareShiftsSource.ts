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
  /**
   * `null` = retrato sem o previsto gravado ainda (`planned_start`/`planned_end` NULL no banco,
   * migration 437) — item 7 da revisão de PR: o repositório NÃO substitui mais por `''` aqui (isso
   * escondia o "não sei" como se fosse um horário válido e produzia `NaN` no cálculo de horas
   * previstas). Quem decide o fallback de exibição é o mapper (`AnaCareHoursMapper`), na fronteira
   * com o contrato de wire do front.
   */
  scheduledStart: string | null;
  scheduledEnd: string | null;
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
  /**
   * 'app' | 'web_admin' | null — origem do CHECKOUT (campo `checkout_source` no cru, existe desde
   * sempre mas não tinha campo no DTO — medido 17/09 contra a API real: gravado NULO na tabela
   * `anacare_shift` (migration 437) por omissão, não por ausência na fonte). Opcional: quem monta
   * o DTO fora de `minimizeShiftDTO` (ex. round-trip de leitura do retrato) não é obrigado a tê-lo.
   */
  checkoutSource?: 'app' | 'web_admin' | null;
  /**
   * Atraso do check-in em minutos, afirmação da fonte (campo `checkin_delay` no cru — mesmo caso
   * de `checkoutSource`: existe na fonte, coluna existe desde a migration 437, gravado NULO por
   * omissão no DTO). Opcional pelo mesmo motivo.
   */
  checkinDelay?: number | null;
  /**
   * `YYYY-MM` afirmado pela PRÓPRIA fonte (campo `month` no cru) — usado só para VALIDAR contra o
   * mês pedido no upsert (`AnaCareShiftRepository.upsertMany` falha alto se divergir, em vez de
   * gravar calado num mês errado). Opcional: não é parte do contrato de leitura do retrato já
   * gravado (`listByMonth`), só do caminho fonte→upsert.
   */
  sourceMonth?: string;
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
