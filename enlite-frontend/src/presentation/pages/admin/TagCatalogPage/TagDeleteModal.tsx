/**
 * TagDeleteModal — modal de confirmação para exclusão de tag.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerTag } from '@domain/entities/WorkerTag';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface TagDeleteModalProps {
  tag: WorkerTag;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function TagDeleteModal({ tag, onConfirm, onClose }: TagDeleteModalProps): JSX.Element {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleConfirm() {
    try {
      setIsLoading(true);
      setError('');
      await onConfirm();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || t('admin.tags.deleteError'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-lg">
        <Heading level={2} weight="semibold" color="primary" className="mb-3">
          {t('admin.tags.deleteTag')}
        </Heading>
        <Text size="sm" color="muted">
          {t('admin.tags.deleteConfirm')}
        </Text>
        <div className="mt-3 flex items-center gap-2">
          <span
            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: tag.color }}
          >
            {tag.name}
          </span>
        </div>

        {error && (
          <Text as="p" size="xs" color="inherit" className="text-red-600 mt-3">
            {error}
          </Text>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 font-lexend cursor-pointer"
            onClick={onClose}
          >
            {t('admin.tags.cancel')}
          </button>
          <Button
            variant="primary"
            className="bg-red-600 border-red-600 hover:bg-red-700"
            onClick={handleConfirm}
            isLoading={isLoading}
          >
            {t('admin.tags.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
