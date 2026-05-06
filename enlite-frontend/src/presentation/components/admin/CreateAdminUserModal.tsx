import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { Heading, Label } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';

export interface CreateAdminUserForm {
  email: string;
  displayName: string;
  role: EnliteRole;
}

interface Props {
  isLoading: boolean;
  onSubmit: (form: CreateAdminUserForm) => Promise<void>;
  onClose: () => void;
}

const DEFAULT_FORM: CreateAdminUserForm = {
  email: '',
  displayName: '',
  role: EnliteRole.ADMIN,
};

export function CreateAdminUserModal({ isLoading, onSubmit, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const [form, setForm] = useState<CreateAdminUserForm>(DEFAULT_FORM);

  const set = (field: keyof CreateAdminUserForm, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async () => {
    if (!form.email || !form.displayName) return;
    await onSubmit(form);
  };

  const roleOptions: { value: EnliteRole; label: string }[] = [
    { value: EnliteRole.ADMIN,             label: t('admin.users.roleAdmin') },
    { value: EnliteRole.RECRUITER,         label: t('admin.users.roleRecruiter') },
    { value: EnliteRole.COMMUNITY_MANAGER, label: t('admin.users.roleCommunityManager') },
  ];

  const inputClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-lg">
        <Heading level={2} weight="semibold" color="primary" className="mb-4">
          {t('admin.users.createUserTitle')}
        </Heading>

        <div className="space-y-3">
          <div>
            <Label htmlFor="cu-email">{t('admin.users.email')}</Label>
            <input
              type="email"
              id="cu-email"
              className={inputClass}
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="cu-displayName">{t('admin.users.name')}</Label>
            <input
              type="text"
              id="cu-displayName"
              className={inputClass}
              value={form.displayName}
              onChange={(e) => set('displayName', e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="cu-role">{t('admin.users.role')}</Label>
            <select
              id="cu-role"
              className={inputClass}
              value={form.role}
              onChange={(e) => set('role', e.target.value)}
            >
              {roleOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
            onClick={onClose}
          >
            {t('admin.users.cancel')}
          </button>
          <Button variant="primary" onClick={handleSubmit} isLoading={isLoading}>
            {t('admin.users.createButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}
