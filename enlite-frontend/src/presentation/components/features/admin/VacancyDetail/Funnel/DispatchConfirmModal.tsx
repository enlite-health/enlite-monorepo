import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface DispatchConfirmModalProps {
  pendingCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DispatchConfirmModal({
  pendingCount,
  onConfirm,
  onCancel,
}: DispatchConfirmModalProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 flex flex-col gap-5">
        <Heading level={3} weight="semibold" color="secondary">
          {t('admin.vacancyDetail.funnelView.dispatchConfirm.title')}
        </Heading>

        <Text size="sm" color="secondary">
          {t('admin.vacancyDetail.funnelView.dispatchConfirm.body', {
            count: pendingCount,
          })}
        </Text>

        <div className="flex justify-end gap-3">
          <Button variant="outline" size="md" onClick={onCancel}>
            {t('admin.vacancyDetail.funnelView.dispatchConfirm.cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={onConfirm}>
            {t('admin.vacancyDetail.funnelView.dispatchConfirm.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
