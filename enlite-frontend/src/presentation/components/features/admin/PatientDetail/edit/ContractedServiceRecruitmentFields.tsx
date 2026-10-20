import { Controller, type Control, type UseFormRegister } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  REQUIRED_PROFESSION_OPTIONS,
  REQUIRED_SEX_OPTIONS,
  WORK_SCHEDULE_OPTIONS,
  RECRUITMENT_TEXT_MAX,
  PAYMENT_DAY_MAX,
} from '@domain/entities/PatientContractedService';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import type { RecruitmentFormValues } from './contractedServiceRecruitmentForm';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';

/**
 * Spec 027 Fase 3 (D507/D508): os 7 campos de recrutamento do serviço contratado, extraídos de
 * `ContractedServiceFormRow` (teto de 400 linhas). Os 5 primeiros (profissões, sexo, experiência, jornada, dia de
 * pagamento ao prestador) são COPIADOS para a vaga ao ativar o recrutamento; `workerAttributes` e `dailyObs` são
 * SÓ FICHA (nunca copiados). Nada de campo de motivo do sexo (lex S.4, D507 item 4).
 */

interface Props {
  index: number;
  control: Control<RecruitmentFormValues>;
  register: UseFormRegister<RecruitmentFormValues>;
  disabled?: boolean;
}

const VACANCY_FORM = 'admin.vacancyDetail.vacancyForm';

export function ContractedServiceRecruitmentFields({ index, control, register, disabled }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  // Vocabulário já traduzido pelo formulário de vaga — um dono só para estes rótulos.
  const sexOptions: SelectOption[] = REQUIRED_SEX_OPTIONS.map((o) => ({ value: o, label: t(`${VACANCY_FORM}.sexOptions.${o}`) }));
  const scheduleOptions: SelectOption[] = WORK_SCHEDULE_OPTIONS.map((o) => ({ value: o, label: t(`${VACANCY_FORM}.workScheduleOptions.${o}`) }));

  return (
    <div className="flex flex-col gap-3" data-testid={`svc-recruitment-${index}`}>
      <div>
        <Text size="sm" weight="semibold" color="secondary">{te('recruitmentSection')}</Text>
        <Text size="sm" color="secondary">{te('recruitmentSectionHint')}</Text>
      </div>

      <FormField label={te('requiredProfessions')} htmlFor={`svc-requiredProfessions-${index}`} required>
        <Controller control={control} name="requiredProfessions" render={({ field }) => (
          <div id={`svc-requiredProfessions-${index}`} className="flex items-center gap-6" data-testid={`svc-requiredProfessions-${index}`}>
            {REQUIRED_PROFESSION_OPTIONS.map((p) => {
              const checked = field.value.includes(p);
              return (
                <Checkbox
                  key={p}
                  id={`svc-profession-${p}-${index}`}
                  label={t(`${VACANCY_FORM}.professionOptions.${p}`)}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => field.onChange(checked ? field.value.filter((v) => v !== p) : [...field.value, p])}
                  data-testid={`svc-profession-${p}-${index}`}
                />
              );
            })}
          </div>
        )} />
      </FormField>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Sem campo de motivo, de propósito: o motivo é clínico e nunca se registra (D507 item 4). */}
        <FormField label={te('requiredSex')} htmlFor={`svc-requiredSex-${index}`} required hint={te('requiredSexHint')} hintBelow>
          <Controller control={control} name="requiredSex" render={({ field }) => (
            <SelectField id={`svc-requiredSex-${index}`} inputSize="compact" options={sexOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} disabled={disabled} data-testid={`svc-requiredSex-${index}`} />
          )} />
        </FormField>
        <FormField label={te('workSchedule')} htmlFor={`svc-workSchedule-${index}`} required>
          <Controller control={control} name="workSchedule" render={({ field }) => (
            <SelectField id={`svc-workSchedule-${index}`} inputSize="compact" options={scheduleOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} disabled={disabled} data-testid={`svc-workSchedule-${index}`} />
          )} />
        </FormField>
      </div>

      {/* Os 4 textos livres (lex T.3): máscara do Clarity no container + dica de que NÃO vai dado de saúde. */}
      <div className="flex flex-col gap-3" data-clarity-mask="True" data-testid={`svc-recruitment-freetext-${index}`}>
        <FormField label={te('requiredExperience')} htmlFor={`svc-requiredExperience-${index}`} required hint={te('requiredExperienceHint')} hintBelow>
          <Textarea id={`svc-requiredExperience-${index}`} inputSize="compact" resize="vertical" rows={2} maxLength={RECRUITMENT_TEXT_MAX} data-testid={`svc-requiredExperience-${index}`} {...register('requiredExperience')} />
        </FormField>
        <FormField label={te('paymentDay')} htmlFor={`svc-paymentDay-${index}`} required hint={te('paymentDayHint')} hintBelow>
          <InputWithIcon id={`svc-paymentDay-${index}`} inputSize="compact" maxLength={PAYMENT_DAY_MAX} data-testid={`svc-paymentDay-${index}`} {...register('paymentDay')} />
        </FormField>
        <FormField label={`${te('workerAttributes')} — ${te('onlyFichaNote')}`} htmlFor={`svc-workerAttributes-${index}`} optional hint={te('freeTextHint')} hintBelow>
          <Textarea id={`svc-workerAttributes-${index}`} inputSize="compact" resize="vertical" rows={2} maxLength={RECRUITMENT_TEXT_MAX} data-testid={`svc-workerAttributes-${index}`} {...register('workerAttributes')} />
        </FormField>
        <FormField label={`${te('dailyObs')} — ${te('onlyFichaNote')}`} htmlFor={`svc-dailyObs-${index}`} optional hint={te('freeTextHint')} hintBelow>
          <Textarea id={`svc-dailyObs-${index}`} inputSize="compact" resize="vertical" rows={2} maxLength={RECRUITMENT_TEXT_MAX} data-testid={`svc-dailyObs-${index}`} {...register('dailyObs')} />
        </FormField>
      </div>
    </div>
  );
}
