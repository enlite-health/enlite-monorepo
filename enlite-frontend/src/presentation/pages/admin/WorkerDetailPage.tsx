import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useWorkerDetail } from '@hooks/admin/useWorkerDetail';
import { WorkerDetailContent } from '@presentation/components/features/admin/WorkerDetail/WorkerDetailContent';

export default function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const backTarget = (location.state as { from?: string } | null)?.from ?? '/admin/workers';

  // Lightweight fetch only to resolve the header title; WorkerDetailContent
  // owns the authoritative fetch + loading/error states for the body.
  const { worker } = useWorkerDetail(id);
  const fullName = worker
    ? [worker.firstName, worker.lastName].filter(Boolean).join(' ') || worker.email
    : '';

  const header = (
    <div className="flex items-center justify-between mb-8">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(backTarget)}
          className="flex items-center gap-1 text-gray-800 hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <Text as="span" size="sm" weight="medium" color="inherit">
            {t('admin.workerDetail.back')}
          </Text>
        </button>
        <ChevronRight className="w-4 h-4 text-gray-600" />
        <Heading level={1} weight="semibold" color="primary">
          {fullName}
        </Heading>
      </div>
    </div>
  );

  const renderError = (message: string) => (
    <div className="w-full min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <Heading level={3} color="inherit" className="text-red-600">
        {message}
      </Heading>
      <Button variant="outline" size="sm" onClick={() => navigate(backTarget)}>
        {t('admin.workerDetail.back')}
      </Button>
    </div>
  );

  return (
    <div className="w-full min-h-screen bg-background px-4 sm:px-8 lg:px-12 xl:px-[120px] py-8">
      <WorkerDetailContent workerId={id} header={header} renderError={renderError} allowEdit />
    </div>
  );
}
