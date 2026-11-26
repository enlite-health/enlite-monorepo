import { useTranslation } from 'react-i18next';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import type { PresenceDecision, PresenceReviewItem } from '@infrastructure/http/AdminPresenceReviewApiService';

/** Motivos que o servidor ou o aparelho dão para uma entrada recusada, e os 4 que a cuidadora escolhe na exceção de lugar (§3.5). Fora destes: texto genérico, nunca o código cru. */
const KNOWN_REASONS = [
  'GPS_INDOOR', 'ADDRESS_WRONG', 'PATIENT_ELSEWHERE', 'OTHER',
  'OCCURRENCE_NOT_OWNED', 'UNKNOWN_OCCURRENCE', 'CLOCK_SUSPECT', 'MOCK_LOCATION', 'MOCK', 'OUT_OF_WINDOW', 'ALREADY_CLOSED',
  'CHECK_OUT_BEFORE_CHECK_IN', 'CHECK_IN_AFTER_CHECK_OUT', 'OUTSIDE', 'INCONCLUSIVE', 'NO_POSITION', 'ADDRESS_UNRELIABLE',
] as const;

interface Props {
  items: PresenceReviewItem[];
  ocupado: boolean;
  onDecidir: (item: PresenceReviewItem, decision: PresenceDecision) => void;
}

const DASH = '—';
const CELL = 'px-3 py-3 align-top text-sm text-[#1A1A1A]';

function shiftLabel(i: PresenceReviewItem): string {
  if (!i.onDate) return DASH;
  const date = i.onDate.split('-').reverse().join('/');
  return i.startTime && i.endTime ? `${date} · ${i.startTime}–${i.endTime}` : date;
}

/**
 * A fila como tabela (§6): tipo · fecha y horario del turno · prestador · paciente (nº do caso) · motivo elegido · distancia y precisión · acción.
 * Aprobar/Rechazar SÓ na exceção de lugar; os outros 3 tipos só se conferem na validação mensal. O estado (pendente) é do attendance — esta tabela só desenha.
 */
export function PresenceReviewTable({ items, ocupado, onDecidir }: Props): JSX.Element {
  const { t } = useTranslation();

  const reasonLabel = (i: PresenceReviewItem): string => {
    if (i.reason) return (KNOWN_REASONS as readonly string[]).includes(i.reason) ? t(`admin.presenceReview.reasons.${i.reason}`) : t('admin.presenceReview.reasons.UNKNOWN');
    return i.exceptionKind === 'GEO_SERVER_DISAGREES' ? t('admin.presenceReview.reasons.SERVER_DETECTED') : DASH;
  };

  const distanceLabel = (i: PresenceReviewItem): string => {
    if (i.distanceM === null && i.accuracyM === null) return DASH;
    return [
      i.distanceM !== null ? t('admin.presenceReview.distance', { meters: i.distanceM }) : null,
      i.accuracyM !== null ? t('admin.presenceReview.accuracy', { meters: i.accuracyM }) : null,
    ].filter(Boolean).join(' · ');
  };

  return (
    <div className="overflow-x-auto rounded-lg border-2 border-[#595959]">
      <table className="w-full min-w-[56rem] border-collapse text-left" data-testid="presence-table">
        <thead className="bg-[#F2F2F2]">
          <tr>
            {(['type', 'shift', 'worker', 'patient', 'reason', 'distance', 'action'] as const).map((c) => (
              <th key={c} scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#262626]">{t(`admin.presenceReview.columns.${c}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const caseLabel = formatCaseNumber(i.caseNumber);
            return (
              <tr key={`${i.kind}:${i.id}`} data-testid="presence-row" data-kind={i.kind} className="border-t border-[#595959]">
                <td className={`${CELL} font-medium`}>{t(`admin.presenceReview.kinds.${i.kind}`)}</td>
                <td className={CELL}>{shiftLabel(i)}</td>
                <td className={CELL}>{i.workerName ?? DASH}</td>
                <td className={CELL}>{caseLabel ? t('admin.presenceReview.caseLabel', { number: caseLabel }) : DASH}</td>
                <td className={CELL}>{reasonLabel(i)}</td>
                <td className={CELL}>{distanceLabel(i)}</td>
                <td className={CELL}>
                  {i.kind === 'EXCEPTION_PENDING' ? (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={ocupado} data-testid="presence-approve" onClick={() => onDecidir(i, 'APPROVED')} className="min-h-[44px] rounded-lg bg-[#262626] px-3 text-sm font-semibold text-white disabled:opacity-60">
                        {t('admin.presenceReview.actions.approve')}
                      </button>
                      <button type="button" disabled={ocupado} data-testid="presence-reject" onClick={() => onDecidir(i, 'REFUSED')} className="min-h-[44px] rounded-lg border-2 border-[#262626] bg-white px-3 text-sm font-semibold text-[#262626] disabled:opacity-60">
                        {t('admin.presenceReview.actions.reject')}
                      </button>
                    </div>
                  ) : (
                    <span data-testid="presence-monthly-check" className="text-[#404040]">{t('admin.presenceReview.monthlyCheck')}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
