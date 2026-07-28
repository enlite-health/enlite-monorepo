import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { List, LayoutGrid } from 'lucide-react';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useToast } from '@presentation/hooks/useToast';
import { usePatientKanban } from '@hooks/admin/usePatientKanban';
import { PatientKanbanBoard } from '@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard';

/** Patient lifecycle kanban page. Route: /admin/patients/kanban. */
export function PatientKanbanPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const showToast = useToast();
  const { groups, isLoading, error, moveStatus } = usePatientKanban();

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <Typography variant="h1" weight="semibold" color="primary" className="font-poppins text-2xl">
          {t('admin.patients.kanban.title')}
        </Typography>
        <div className="flex items-center gap-2" data-testid="patients-view-toggle">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/admin/patients')}
            className="flex items-center gap-1"
            data-testid="patients-view-list"
          >
            <List className="w-4 h-4" />
            {t('admin.patients.kanban.toggleList')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex items-center gap-1"
            data-testid="patients-view-kanban"
          >
            <LayoutGrid className="w-4 h-4" />
            {t('admin.patients.kanban.toggleKanban')}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="py-8 text-center">
          <Typography variant="h3" className="text-red-600 mb-2">
            {t('admin.patients.errorLoading')}
          </Typography>
          <Typography variant="body" className="text-slate-600">{error}</Typography>
        </div>
      ) : isLoading ? (
        <TableSkeleton />
      ) : (
        <PatientKanbanBoard
          groups={groups}
          onMove={async (patientId, target) => {
            const err = await moveStatus(patientId, target);
            if (err) showToast(t('admin.patients.kanban.moveError'), 'error');
            return err;
          }}
        />
      )}
    </PageContainer>
  );
}
