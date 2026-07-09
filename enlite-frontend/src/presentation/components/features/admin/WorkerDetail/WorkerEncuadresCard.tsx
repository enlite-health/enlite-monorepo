import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import type { WorkerEncuadre, WorkerEncuadreKanbanStage } from '@domain/entities/Worker';

interface WorkerEncuadresCardProps {
  encuadres: WorkerEncuadre[];
}

/**
 * Cor do badge por coluna do Kanban — alinhado com KanbanBoard.COLUMN_CONFIG para que
 * o operador reconheça o mesmo código de cor da ficha e do board.
 */
const STAGE_COLORS: Record<WorkerEncuadreKanbanStage, string> = {
  INVITED: 'bg-blue-100 text-blue-700',
  BLOQUEADO: 'bg-red-100 text-red-700',
  INICIADO: 'bg-indigo-100 text-indigo-700',
  PRE_SCREENING: 'bg-violet-100 text-violet-700',
  IN_PROGRESS: 'bg-violet-100 text-violet-700',
  COMPLETED: 'bg-violet-100 text-violet-700',
  CONFIRMED: 'bg-cyan-100 text-cyan-700',
  SELECTED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
};

export function WorkerEncuadresCard({ encuadres }: WorkerEncuadresCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <Heading level={3} as="h3" weight="semibold" color="secondary">
        {t('admin.workerDetail.encuadres')} ({encuadres.length})
      </Heading>

      {encuadres.length === 0 ? (
        <Text size="sm" color="secondary">
          {t('admin.workerDetail.noEncuadres')}
        </Text>
      ) : (
        <Table>
          <TableHeader>
            <TableHead>{t('admin.workerDetail.case')}</TableHead>
            <TableHead>{t('admin.workerDetail.patient')}</TableHead>
            <TableHead>{t('admin.workerDetail.funnelStatus')}</TableHead>
            <TableHead>{t('admin.workerDetail.interview')}</TableHead>
            <TableHead>{t('admin.workerDetail.recruiter')}</TableHead>
            <TableHead>{t('admin.workerDetail.date')}</TableHead>
          </TableHeader>
          <TableBody>
            {encuadres.map((e) => {
              const stageColor = STAGE_COLORS[e.kanbanStage] ?? 'bg-gray-100 text-gray-600';
              const interviewDisplay = e.interviewDate
                ? `${new Date(e.interviewDate).toLocaleDateString('es-AR')}${e.interviewTime ? ` ${e.interviewTime}` : ''}`
                : '—';

              return (
                <TableRow
                  key={e.id}
                  onClick={
                    e.jobPostingId
                      ? () => navigate(`/admin/vacancies/${e.jobPostingId}`)
                      : undefined
                  }
                >
                  <TableCell weight="medium">{e.caseNumber ?? '—'}</TableCell>
                  <TableCell>{e.patientName ?? '—'}</TableCell>
                  <TableCell unwrapped>
                    <span className={`inline-flex px-2 py-0.5 rounded-full ${stageColor}`}>
                      <Text as="span" size="xs" weight="medium" color="inherit">
                        {t(`admin.kanban.columns.${e.kanbanStage}`, { defaultValue: e.kanbanStage })}
                      </Text>
                    </span>
                    {e.isBlocked && e.attemptCount ? (
                      <Text as="span" size="xs" color="secondary" className="ml-2">
                        {t('admin.workerDetail.attemptCount', { count: e.attemptCount, defaultValue: `${e.attemptCount} intento(s)` })}
                      </Text>
                    ) : null}
                  </TableCell>
                  <TableCell>{interviewDisplay}</TableCell>
                  <TableCell>{e.recruiterName ?? '—'}</TableCell>
                  <TableCell>
                    {new Date(e.createdAt).toLocaleDateString('es-AR')}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
