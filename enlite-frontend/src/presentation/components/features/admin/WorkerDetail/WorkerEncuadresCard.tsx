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
import type { WorkerEncuadre } from '@domain/entities/Worker';

interface WorkerEncuadresCardProps {
  encuadres: WorkerEncuadre[];
}

const RESULTADO_COLORS: Record<string, string> = {
  SELECCIONADO: 'bg-green-100 text-green-700',
  RECHAZADO: 'bg-red-100 text-red-700',
  AT_NO_ACEPTA: 'bg-orange-100 text-orange-700',
  PENDIENTE: 'bg-yellow-100 text-yellow-700',
  REPROGRAMAR: 'bg-blue-100 text-blue-700',
  REEMPLAZO: 'bg-purple-100 text-purple-700',
  BLACKLIST: 'bg-gray-800 text-white',
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
            <TableHead>{t('admin.workerDetail.result')}</TableHead>
            <TableHead>{t('admin.workerDetail.interview')}</TableHead>
            <TableHead>{t('admin.workerDetail.recruiter')}</TableHead>
            <TableHead>{t('admin.workerDetail.date')}</TableHead>
          </TableHeader>
          <TableBody>
            {encuadres.map((e) => {
              const resultColor =
                RESULTADO_COLORS[e.resultado ?? ''] ?? 'bg-gray-100 text-gray-600';
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
                    <span className={`inline-flex px-2 py-0.5 rounded-full ${resultColor}`}>
                      <Text as="span" size="xs" weight="medium" color="inherit">
                        {e.resultado
                          ? t(`admin.vacancyDetail.resultadoLabels.${e.resultado}`, {
                              defaultValue: e.resultado,
                            })
                          : '—'}
                      </Text>
                    </span>
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
