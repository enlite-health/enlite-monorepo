import { useTranslation } from 'react-i18next';
import { AdminUser } from '@domain/entities/AdminUser';
import { Heading, Text } from '@presentation/components/atoms';

interface Props {
  target: AdminUser;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteAdminUserModal({ target, onConfirm, onClose }: Props): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-lg">
        <Heading level={2} weight="semibold" color="primary" className="mb-2">
          {t('admin.users.confirmDelete')}
        </Heading>
        <Text as="p" size="sm" color="secondary" className="mb-6">
          {t('admin.users.confirmDeleteDesc')} <strong>{target.email}</strong>
        </Text>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
            onClick={onClose}
          >
            {t('admin.users.cancel')}
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
            onClick={onConfirm}
          >
            {t('admin.users.deleteConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
