import { List, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type FunnelView = 'list' | 'kanban';

interface ToggleButtonProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  ariaLabel: string;
  onClick: () => void;
}

function ToggleButton({
  active,
  icon,
  label,
  ariaLabel,
  onClick,
}: ToggleButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? 'bg-primary text-white px-5 py-2 rounded-pill font-lexend font-medium text-base flex items-center gap-2 shadow-[0px_4px_10px_rgba(0,0,0,0.4)] transition-colors'
          : 'text-gray-800 hover:text-primary px-5 py-2 rounded-pill font-lexend font-medium text-base flex items-center gap-2 transition-colors'
      }
    >
      {icon}
      {label}
    </button>
  );
}

interface VacancyFunnelToggleProps {
  view: FunnelView;
  onChange: (view: FunnelView) => void;
}

export function VacancyFunnelToggle({
  view,
  onChange,
}: VacancyFunnelToggleProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      className="border-[1.5px] border-gray-400 rounded-pill p-1 inline-flex gap-1"
      role="group"
      aria-label={t('admin.vacancyDetail.funnelView.viewToggle.label')}
    >
      <ToggleButton
        active={view === 'list'}
        icon={<List size={16} aria-hidden="true" />}
        label={t('admin.vacancyDetail.funnelView.viewToggle.list')}
        ariaLabel={t('admin.vacancyDetail.funnelView.viewToggle.list')}
        onClick={() => onChange('list')}
      />
      <ToggleButton
        active={view === 'kanban'}
        icon={<LayoutGrid size={16} aria-hidden="true" />}
        label={t('admin.vacancyDetail.funnelView.viewToggle.kanban')}
        ariaLabel={t('admin.vacancyDetail.funnelView.viewToggle.kanban')}
        onClick={() => onChange('kanban')}
      />
    </div>
  );
}
