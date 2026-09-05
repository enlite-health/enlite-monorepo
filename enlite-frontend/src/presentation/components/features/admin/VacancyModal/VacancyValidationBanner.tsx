import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

interface Props {
  fields: string[];
}

/**
 * Spec 014 (US-D6, lex D6.1): banner de validação da Nueva Vacante — lista NOMES de campo,
 * nunca valor. `fields` só recebe rótulos i18n (`listInvalidFields`), nunca `errs.message` nem
 * o que a pessoa digitou. Extraído de `VacancyFormSection` para manter as 400 linhas.
 */
export function VacancyValidationBanner({ fields }: Props): JSX.Element | null {
  const { t } = useTranslation();
  if (fields.length === 0) return null;

  return (
    <div
      className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-6"
      role="alert"
      data-testid="vacancy-validation-banner"
    >
      <Text size="sm" weight="medium" className="text-red-700">
        {t('admin.vacancyModal.validationBanner.title')}
      </Text>
      <ul className="mt-1 list-disc list-inside">
        {fields.map((label) => (
          <li key={label}>
            <Text as="span" size="sm" className="text-red-600">{label}</Text>
          </li>
        ))}
      </ul>
    </div>
  );
}
