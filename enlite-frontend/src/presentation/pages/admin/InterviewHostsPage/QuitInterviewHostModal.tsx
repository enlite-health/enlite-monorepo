import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  name: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function QuitInterviewHostModal({ name, busy = false, error = null, onConfirm, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="quitar-modal">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-lg" role="alertdialog" aria-modal="true" aria-label={t('admin.interviewHosts.quitModal.title')}>
        <Heading level={2} weight="semibold" color="primary" className="mb-3">
          {t('admin.interviewHosts.quitModal.title')}
        </Heading>
        <Text size="sm" color="inherit" className="text-slate-700">
          {t('admin.interviewHosts.quitModal.body', { name })}
        </Text>
        {error && (
          <Text size="sm" color="inherit" role="alert" className="mt-3 text-red-800" data-testid="quitar-error">{error}</Text>
        )}
        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            className="px-4 py-2 text-sm text-gray-800 hover:text-slate-900 font-lexend cursor-pointer"
            onClick={onClose}
          >
            {t('admin.interviewHosts.quitModal.cancel')}
          </button>
          <Button variant="primary" className="bg-red-600 border-red-600 hover:bg-red-700" disabled={busy} onClick={onConfirm} data-testid="quitar-confirm">
            {t('admin.interviewHosts.quitModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
