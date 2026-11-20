/** Porta de leitura do painel (spec 092): os informes de UM paciente. O adapter só SELECIONA o texto quando `withNarrative` (minimização). */
export interface AdminReportAnswerRow {
  itemKind: 'objective' | 'activity';
  itemId: string;
  itemTitle: string;
  scaleCode: string;
  optionCode: string | null;
  countValue: number | null;
  reasonCode: string | null;
  /** Nota por join (DC-6); `null` = a planilha não define (L1) ou escala de contagem. */
  score: number | null;
  /** Aviso IMEDIATO da planilha (DC-5): sinal derivado, nunca ação automática. */
  immediateAlert: boolean;
}

export interface AdminReportRow {
  id: string;
  workerId: string;
  onDate: string;
  ptiVersionId: string | null;
  narrativeSource: 'TYPED' | 'DICTATED' | 'MIXED';
  deviceSubmittedAt: Date;
  receivedAt: Date;
  appVersion: string;
  /** Fim programado da guarda (instante), para o atraso DERIVADO (DC-2). */
  guardEndsAt: Date;
  /** `null` quando `withNarrative = false` (o texto nem foi lido). */
  narrative: string | null;
  answers: AdminReportAnswerRow[];
}

export interface DailyReportAdminPort {
  /** `null` = paciente inexistente/fora do escopo (RLS) → 404. */
  listForPatient(args: { patientId: string; from: string | null; to: string | null; withNarrative: boolean }): Promise<AdminReportRow[] | null>;
}
