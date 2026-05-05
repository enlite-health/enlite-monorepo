import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';
import { KanbanBoard } from '@presentation/components/features/admin/Kanban/KanbanBoard';
import { useEncuadreFunnel } from '@hooks/admin/useEncuadreFunnel';

interface VacancyFunnelKanbanProps {
  vacancyId: string;
}

export function VacancyFunnelKanban({
  vacancyId,
}: VacancyFunnelKanbanProps): JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch, moveEncuadre } =
    useEncuadreFunnel(vacancyId);

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-header with refresh */}
      <div className="flex items-center justify-between">
        {data && (
          <Typography variant="caption" className="text-gray-800">
            {data.totalEncuadres} {t('admin.vacancyDetail.funnelView.kanban.totalEncuadres')}
          </Typography>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isLoading}
          className="ml-auto"
        >
          <RefreshCw
            className={`w-4 h-4 mr-1.5 ${isLoading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {t('admin.vacancyDetail.funnelView.kanban.refresh')}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <Typography variant="body" className="text-red-700">
            {error}
          </Typography>
        </div>
      )}

      {/* Loading */}
      {isLoading && !data && (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      )}

      {/* Board */}
      {data?.stages && (
        <KanbanBoard stages={data.stages} onMove={moveEncuadre} />
      )}
    </div>
  );
}
