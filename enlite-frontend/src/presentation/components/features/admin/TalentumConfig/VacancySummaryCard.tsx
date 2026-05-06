import { useTranslation } from 'react-i18next';
import { Typography } from '@presentation/components/atoms/Typography';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VacancySummaryData {
  caseNumber: number | null;
  vacancyNumber: number | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  status: string | null;
  publishedAt: string | null;
  closedAt: string | null;
}

interface Props {
  data: VacancySummaryData;
}

// ---------------------------------------------------------------------------
// Status badge color map
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  BUSQUEDA: 'bg-blue-100 text-blue-700',
  ACTIVO: 'bg-green-100 text-green-700',
  PAUSADO: 'bg-yellow-100 text-yellow-700',
  CERRADO: 'bg-red-100 text-red-700',
  PENDING_ACTIVATION: 'bg-gray-100 text-gray-600',
};

function statusBadgeCls(status: string | null): string {
  if (!status) return 'bg-gray-100 text-gray-600';
  return STATUS_COLORS[status.toUpperCase()] ?? 'bg-gray-100 text-gray-600';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VacancySummaryCard({ data }: Props) {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.talentumConfig.summaryCard.${k}`);

  const title =
    data.caseNumber != null && data.vacancyNumber != null
      ? `CASO ${data.caseNumber}-${data.vacancyNumber}`
      : tc('noTitle');

  const patientName =
    data.patientFirstName || data.patientLastName
      ? `${data.patientFirstName ?? ''} ${data.patientLastName ?? ''}`.trim()
      : tc('noPatient');

  return (
    <div className="bg-white border-2 border-[#d9d9d9] rounded-[10px] p-6 flex flex-col gap-2">
      {/* Title */}
      <Typography
        variant="h2"
        weight="semibold"
        className="font-['Poppins'] text-[20px] text-[#180149]"
      >
        {title}
      </Typography>

      {/* Patient + case line */}
      <p className="font-['Lexend'] font-medium text-[16px] text-[#737373] leading-snug">
        {tc('patientLabel')}: {patientName}
        {data.caseNumber != null && (
          <span className="ml-2 text-[#737373]">· CASO {data.caseNumber}</span>
        )}
      </p>

      {/* Dates + status */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-['Lexend'] text-[14px] text-[#737373]">
          {tc('publishedLabel')}: {formatDate(data.publishedAt)}
        </span>
        {data.closedAt && (
          <span className="font-['Lexend'] text-[14px] text-[#737373]">
            · {tc('closedLabel')}: {formatDate(data.closedAt)}
          </span>
        )}
        {data.status && (
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBadgeCls(data.status)}`}
          >
            {t(`admin.vacancyDetail.vacancyForm.statusOptions.${data.status}`, {
              defaultValue: data.status,
            })}
          </span>
        )}
      </div>
    </div>
  );
}
