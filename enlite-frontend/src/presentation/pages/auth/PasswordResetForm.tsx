import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { FormField, PasswordInput } from '@presentation/components/molecules';

const resetSchema = z
  .object({
    newPassword: z.string().min(8, 'auth.action.passwordMin'),
    confirmPassword: z.string().min(1, 'auth.action.passwordMin'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'auth.action.passwordMismatch',
    path: ['confirmPassword'],
  });

interface PasswordResetFormProps {
  email: string;
  isSubmitting: boolean;
  submitError: string | null;
  onSubmit: (newPassword: string) => void;
}

export function PasswordResetForm({
  email,
  isSubmitting,
  submitError,
  onSubmit,
}: PasswordResetFormProps): JSX.Element {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const result = resetSchema.safeParse({ newPassword, confirmPassword });
    if (!result.success) {
      setValidationError(t(result.error.errors[0].message));
      return;
    }

    onSubmit(newPassword);
  };

  const displayError = submitError ?? validationError;

  return (
    <div className="flex flex-col gap-6 w-full">
      <div className="flex flex-col gap-1 text-center">
        <Heading level={2} weight="semibold" color="primary">
          {t('auth.action.title')}
        </Heading>
        <Text size="sm" color="secondary">
          {t('auth.action.titleFor', { email })}
        </Text>
      </div>

      <form className="flex flex-col gap-5 w-full" onSubmit={handleSubmit}>
        {displayError && (
          <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-lg">
            <Text as="span" size="sm" color="primary">
              {displayError}
            </Text>
          </div>
        )}

        <div className="flex flex-col gap-3 w-full">
          <FormField
            label={t('auth.action.newPasswordLabel')}
            htmlFor="new-password"
          >
            <PasswordInput
              id="new-password"
              placeholder={t('common.passwordPlaceholder')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={isSubmitting}
            />
          </FormField>

          <FormField
            label={t('auth.action.confirmPasswordLabel')}
            htmlFor="confirm-password"
          >
            <PasswordInput
              id="confirm-password"
              placeholder={t('common.passwordPlaceholder')}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={isSubmitting}
            />
          </FormField>
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          isLoading={isSubmitting}
        >
          {t('auth.action.submit')}
        </Button>
      </form>
    </div>
  );
}
