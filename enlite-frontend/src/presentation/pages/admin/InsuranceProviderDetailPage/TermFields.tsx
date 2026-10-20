/**
 * TermFields — os 4 campos de um termo de valor (valor-hora, imposto, início, fim), usados tanto no "novo contrato + 1º termo"
 * quanto no "novo termo". O imposto nasce vazio e obrigatório (ver `termDraft.ts`); o início usa o `asOf` da resposta como mínimo.
 */
import { useTranslation } from 'react-i18next';
import { Input } from '@presentation/components/atoms/Input';
import { Field } from './Field';
import { Text } from '@presentation/components/atoms/Text';
import { formatCalendarDate, isDayBefore } from './calendar';
import type { TermDraftState } from './termDraft';

interface Props {
  state: TermDraftState;
  /** O "hoje" do país vindo da API — mínimo e início sugerido. `null` = ainda não se sabe. */
  asOf: string | null;
  /** Prefixo dos data-testid (`<prefixo>hourly-rate`, `tax-rate`, `valid-from`, `valid-to`, `retro-warning`). */
  testIdPrefix: string;
}

const NS = 'admin.insuranceProviders.contracts.termForm';

export function TermFields({ state, asOf, testIdPrefix }: Props): JSX.Element {
  const { t } = useTranslation();
  const { draft, errors, set } = state;
  const err = (key: keyof typeof errors): string | undefined => (errors[key] ? t(`${NS}.${errors[key]}`) : undefined);
  const retroactive = asOf !== null && isDayBefore(draft.validFrom, asOf);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label={t(`${NS}.hourlyRate`)} required error={err('hourlyRate')} htmlFor={`${testIdPrefix}hourly-rate`}>
        <Input
          id={`${testIdPrefix}hourly-rate`}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={draft.hourlyRate}
          onChange={(e) => set('hourlyRate', e.target.value)}
          error={err('hourlyRate')}
          data-testid={`${testIdPrefix}hourly-rate`}
        />
      </Field>
      <Field label={t(`${NS}.tax`)} required hint={t(`${NS}.taxHelp`)} error={err('taxRatePercent')} htmlFor={`${testIdPrefix}tax-rate`}>
        {/* value="" de propósito: o imposto nasce VAZIO. `0` = isento é uma escolha digitada, nunca um default. */}
        <Input
          id={`${testIdPrefix}tax-rate`}
          type="number"
          inputMode="decimal"
          min="0"
          max="100"
          step="0.01"
          value={draft.taxRatePercent}
          onChange={(e) => set('taxRatePercent', e.target.value)}
          error={err('taxRatePercent')}
          data-testid={`${testIdPrefix}tax-rate`}
        />
      </Field>
      <Field label={t(`${NS}.validFrom`)} required error={err('validFrom')} htmlFor={`${testIdPrefix}valid-from`}>
        {asOf === null ? (
          <Text size="xs" color="inherit" className="text-slate-600" data-testid={`${testIdPrefix}as-of-loading`}>{t(`${NS}.asOfLoading`)}</Text>
        ) : (
          <Input
            id={`${testIdPrefix}valid-from`}
            type="date"
            min={asOf}
            value={draft.validFrom}
            onChange={(e) => set('validFrom', e.target.value)}
            error={err('validFrom')}
            data-testid={`${testIdPrefix}valid-from`}
          />
        )}
        {retroactive && asOf !== null && (
          <span data-testid={`${testIdPrefix}retro-warning`} role="status">
            <Text color="inherit" size="xs" className="text-amber-800">{t(`${NS}.retroWarning`, { asOf: formatCalendarDate(asOf) })}</Text>
          </span>
        )}
      </Field>
      <Field label={t(`${NS}.validTo`)} error={err('validTo')} htmlFor={`${testIdPrefix}valid-to`}>
        <Input
          id={`${testIdPrefix}valid-to`}
          type="date"
          min={draft.validFrom || undefined}
          value={draft.validTo}
          onChange={(e) => set('validTo', e.target.value)}
          error={err('validTo')}
          data-testid={`${testIdPrefix}valid-to`}
        />
      </Field>
    </div>
  );
}
