import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

interface Props {
  patient: PatientKanbanItem;
}

/**
 * Lightweight card for the patient kanban. Intentionally minimal — name + case
 * number + dependency only, no sensitive clinical data on the board (privacy).
 * Reuses the visual language of KanbanCard without its worker-funnel props.
 */
export function PatientKanbanCard({ patient }: Props): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const fullName = [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim()
    || t('admin.patients.kanban.noName', { defaultValue: 'Sin nombre' });
  const dependencyLabel = patient.dependencyLevel
    ? t(`admin.patients.dependencyOptions.${patient.dependencyLevel}`, { defaultValue: patient.dependencyLevel })
    : null;

  return (
    <div
      data-testid={`patient-kanban-card-${patient.id}`}
      className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="text-left truncate"
          onClick={(e) => { e.stopPropagation(); navigate(`/admin/patients/${patient.id}`); }}
          data-testid={`patient-kanban-card-${patient.id}-open`}
        >
          <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate hover:underline">
            {fullName}
          </Text>
        </button>
        {patient.caseNumber != null && (
          <span className="shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700">
            {t('admin.patients.kanban.caseNumber', { defaultValue: 'Caso' })} #{patient.caseNumber}
          </span>
        )}
      </div>
      {dependencyLabel && (
        <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600">
          {dependencyLabel}
        </span>
      )}
    </div>
  );
}
