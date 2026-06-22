import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { WorkerDetailContent } from './WorkerDetailContent';

interface WorkerProfileModalProps {
  workerId: string;
  onClose: () => void;
}

/**
 * Read-only worker profile overlay opened from the match candidate list.
 *
 * Hand-rolled modal (no shared Modal atom exists yet — see docs/FOLLOWUPS.md
 * TD-054). Closes via the X button, backdrop click and the ESC key. The body
 * is the shared WorkerDetailContent so the modal stays in sync with the page.
 */
export function WorkerProfileModal({ workerId, onClose }: WorkerProfileModalProps): JSX.Element {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
      data-testid="worker-profile-modal-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.workerDetail.modal.title')}
        className="bg-background rounded-card w-full max-w-5xl my-8 shadow-lg relative"
        onClick={(e) => e.stopPropagation()}
        data-testid="worker-profile-modal"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <Heading level={2} weight="semibold" color="primary">
            {t('admin.workerDetail.modal.title')}
          </Heading>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('admin.workerDetail.modal.close')}
            className="p-1.5 rounded-lg text-gray-800 hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pb-6">
          <WorkerDetailContent workerId={workerId} />
        </div>
      </div>
    </div>
  );
}
