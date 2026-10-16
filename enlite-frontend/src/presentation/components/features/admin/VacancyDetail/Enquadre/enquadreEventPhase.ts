/**
 * enquadreEventPhase — fase do evento (derivada NO SERVIDOR) → tom do chip e chave do texto. Fora do componente
 * (react-refresh). `Record` fecha o conjunto: uma fase nova sem tom/texto aqui reprova no tsc.
 */
import type { EnquadreEventPhase } from '@domain/entities/EnquadreEvent';
import type { SealTone } from '../../PatientDetail/admission/sealTones';

export const ENQUADRE_PHASE_TONE: Record<EnquadreEventPhase, SealTone> = {
  scheduled: 'neutral',
  pending_close: 'warn',
  closed: 'ok',
  cancelled: 'neutral',
};

/** Chave sob `admin.vacancyDetail.enquadre.`. */
export const ENQUADRE_PHASE_KEY: Record<EnquadreEventPhase, string> = {
  scheduled: 'phase.scheduled',
  pending_close: 'phase.pending_close',
  closed: 'phase.closed',
  cancelled: 'phase.cancelled',
};

/** Fase aberta = ainda aceita ações do operador (encerrar, cancelar, mover, gerir convocados). */
export const ENQUADRE_PHASE_OPEN: Record<EnquadreEventPhase, boolean> = {
  scheduled: true,
  pending_close: true,
  closed: false,
  cancelled: false,
};

/** Ordem da lista: pendente de encerrar (pede ação) → próximos → encerrados → cancelados no fim. */
export const ENQUADRE_PHASE_ORDER: Record<EnquadreEventPhase, number> = {
  pending_close: 0,
  scheduled: 1,
  closed: 2,
  cancelled: 3,
};
