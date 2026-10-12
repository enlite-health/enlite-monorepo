/**
 * Andamento da reunião na aba Admissão (spec 050 §19.3, F29). DONO do conceito: o front só escolhe o texto pela chave do `state`.
 * Função PURA: sem banco, sem relógio. Lê o que o painel já lê (início/fim reais, `import_status`, data do documento do resumo)
 * mais a existência do evento `conference_reopened` com `reason='after_summary'` (R-50).
 *
 * Fim cedo sem armar (R-56) NÃO põe `import_status='pending'`, então cai em `ended`, nunca em "em preparação".
 */
export type CallProgressState =
  | 'none'
  | 'in_progress'
  | 'ended'
  | 'summary_preparing'
  | 'summary_ready'
  | 'reopened_after_summary';

export interface CallProgressFacts {
  conferenceStartedAt: Date | null;
  conferenceEndedAt: Date | null;
  importStatus: string | null;
  /** `patient_documents.created_at` do resumo ligado à reunião; `null` = ainda não existe. */
  summaryCreatedAt: Date | null;
  /** Instante do evento `conference_reopened` com `reason='after_summary'`; `null` = não houve. */
  reopenedAfterSummaryAt: Date | null;
}

export interface CallProgress {
  state: CallProgressState;
  /** Hora que a tela mostra (ISO), quando o estado tem uma; `null` nos demais. */
  at: string | null;
}

/** `import_status` em que o fim está gravado e a importação ainda vai (ou está tentando) gerar o resumo. */
const PREPARING_IMPORT_STATUS: ReadonlyArray<string | null> = ['pending', 'waiting'];

export function callProgressOf(f: CallProgressFacts): CallProgress {
  if (f.reopenedAfterSummaryAt) return { state: 'reopened_after_summary', at: f.reopenedAfterSummaryAt.toISOString() };
  if (f.summaryCreatedAt) return { state: 'summary_ready', at: f.summaryCreatedAt.toISOString() };
  if (f.conferenceEndedAt) {
    const preparing = PREPARING_IMPORT_STATUS.includes(f.importStatus);
    return { state: preparing ? 'summary_preparing' : 'ended', at: f.conferenceEndedAt.toISOString() };
  }
  if (f.conferenceStartedAt) return { state: 'in_progress', at: f.conferenceStartedAt.toISOString() };
  return { state: 'none', at: null };
}
