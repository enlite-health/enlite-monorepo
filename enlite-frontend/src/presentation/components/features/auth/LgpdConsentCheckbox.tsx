import { useTranslation } from 'react-i18next';
import { Checkbox } from '@presentation/components/atoms';
import { Text } from '@presentation/components/atoms/Text';

export interface LgpdConsentCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
}

/**
 * A caixa do aceite LGPD/Ley 25.326 (texto i18n `register.lgpd*`). Uma só para o cadastro
 * (`RegisterPage`) e para o código do claim (`ClaimOtpModal`) de quem entra pelo Google.
 */
export function LgpdConsentCheckbox({ checked, onChange, error }: LgpdConsentCheckboxProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <Checkbox
      id="lgpdOptIn"
      labelContent={
        <div className="flex flex-col gap-0.5">
          <Text as="span" size="sm" weight="semibold" color="inherit">{t('register.lgpdOptIn')}</Text>
          <Text as="span" size="sm" color="secondary">{t('register.lgpdSubtitle')}</Text>
          <Text as="span" size="xs" color="secondary">
            {t('register.lgpdBody')
              .split('{termsLink}')
              .flatMap((partBeforeTerms, i) => {
                if (i > 0) return [partBeforeTerms];
                return [
                  partBeforeTerms,
                  <a
                    key="terms"
                    href="https://enlite.health/es/politica-de-privacidad/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-primary"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t('register.lgpdTermsLinkText')}
                  </a>,
                ];
              })
              .flatMap((part, i) => {
                if (typeof part !== 'string') return [part];
                const segments = part.split('{emailLink}');
                if (segments.length === 1) return [part];
                return [
                  segments[0],
                  <a
                    key={`email-${i}`}
                    href="mailto:enlite@enlite.health"
                    className="underline text-primary"
                    onClick={(e) => e.stopPropagation()}
                  >
                    enlite@enlite.health
                  </a>,
                  segments[1],
                ];
              })}
          </Text>
        </div>
      }
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      error={error}
    />
  );
}
