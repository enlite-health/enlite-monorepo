/**
 * Informe da guarda no painel (spec 092, T501). Forma de `GET /api/admin/patients/:patientId/daily-reports`
 * (`GetPatientDailyReportsUseCase`, worker-functions). O TEXTO (`narrative`) só vem com `daily_report_narrative:read`:
 * sem a célula a API devolve `narrative: null` + `narrativeRedacted: true` e nem lê o texto do banco.
 */
export interface PatientDailyReportAnswer {
  itemKind: 'objective' | 'activity';
  itemId: string;
  itemTitle: string;
  scaleCode: string;
  /** Escolha da escala; `null` quando a escala é de contagem (`countValue`). */
  optionCode: string | null;
  countValue: number | null;
  reasonCode: string | null;
  /** Nota por join (DC-6); `null` = a planilha não define nota (L1) ou escala de contagem. */
  score: number | null;
  /** Aviso IMEDIATO da planilha (DC-5): sinal derivado, nunca ação automática. */
  immediateAlert: boolean;
}

export interface PatientDailyReport {
  id: string;
  /** A rota devolve o id do prestador, NÃO o nome (nome exigiria `worker_contact:read`). */
  workerId: string;
  /** `YYYY-MM-DD` — só-data. */
  onDate: string;
  ptiVersionId: string | null;
  narrativeSource: 'TYPED' | 'DICTATED' | 'MIXED';
  deviceSubmittedAt: string;
  receivedAt: string;
  appVersion: string;
  /** Derivado no servidor (DC-2): enviado depois de fim da guarda + 24 h. */
  late: boolean;
  answersCount: number;
  immediateAlert: boolean;
  answers: PatientDailyReportAnswer[];
  narrative: string | null;
  narrativeRedacted: boolean;
}

export interface PatientDailyReportsResult {
  items: PatientDailyReport[];
}
