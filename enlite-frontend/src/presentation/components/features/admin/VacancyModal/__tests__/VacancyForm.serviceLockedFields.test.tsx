/**
 * 057 / T4.2 — com `locked_fields` trazendo os 5 campos de recrutamento do serviço (D523), o form
 * trava os inputs que existem (profissão, sexo, dia de pagamento), mostra o link para a ficha e
 * o PUT (buildVacancyPayload + stripLockedFields) não leva nenhum dos 5.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { VacancyFormLeftColumn } from '../VacancyFormLeftColumn';
import { VacancyFormRightColumn } from '../VacancyFormRightColumn';
import { DEFAULT_FORM_VALUES, buildVacancyPayload, type VacancyFormData } from '../../vacancy-form-schema';
import { KNOWN_LOCKED_FIELDS } from '../../VacancyDetail/draftVacancyFields';
import { lockedFormFields, stripLockedFields } from '../../vacancyLockedFields';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getCasesForSelect: vi.fn().mockResolvedValue([]) },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/molecules/ServiceAreaMap', () => ({ ServiceAreaMap: () => null }));

function Harness({ locked }: { locked: readonly string[] }) {
  const { register, control, formState: { errors } } = useForm<VacancyFormData>({
    defaultValues: DEFAULT_FORM_VALUES,
  });
  const lockedFields = lockedFormFields(locked);
  return (
    <>
      <VacancyFormLeftColumn
        mode="edit"
        register={register}
        control={control}
        errors={errors}
        patientSelected
        diagnoses={[]}
        diagnosesUnavailable={false}
        patientName="Paciente"
        selectedCaseNumber={1}
        selectedPatientId="p-42"
        dependencyLevel={null}
        selectCase={vi.fn()}
        setValue={vi.fn()}
        lockedFields={lockedFields}
      />
      <VacancyFormRightColumn
        register={register}
        control={control}
        errors={errors}
        patientSelected
        addresses={[]}
        selectedAddressId={null}
        isLoadingPatient={false}
        patientError={null}
        selectAddress={vi.fn()}
        lockedFields={lockedFields}
        patientId="p-42"
      />
    </>
  );
}

describe('form da vaga com serviço — 5 campos de recrutamento travados (057/T4.2)', () => {
  it('locked_fields com os 13: sexo, dia de pagamento e profissões ficam disabled e mostram o link da ficha', () => {
    render(<Harness locked={[...KNOWN_LOCKED_FIELDS]} />);
    expect(screen.getByTestId('required-sex-select')).toBeDisabled();
    expect(screen.getByTestId('payment-day-input')).toBeDisabled();
    expect(screen.getByTestId('profession-checkbox-AT')).toBeDisabled();
    for (const id of ['locked-field-link-sex', 'locked-field-link-payment-day', 'locked-field-link-professions']) {
      expect(screen.getByTestId(id)).toHaveAttribute('href', expect.stringContaining('p-42'));
    }
  });

  it('vaga sem serviço (locked_fields vazio): nada disabled e nenhum link novo', () => {
    render(<Harness locked={[]} />);
    expect(screen.getByTestId('required-sex-select')).not.toBeDisabled();
    expect(screen.getByTestId('payment-day-input')).not.toBeDisabled();
    expect(screen.getByTestId('profession-checkbox-AT')).not.toBeDisabled();
    expect(screen.queryByTestId('locked-field-link-sex')).toBeNull();
    expect(screen.queryByTestId('locked-field-link-payment-day')).toBeNull();
    expect(screen.queryByTestId('locked-field-link-professions')).toBeNull();
  });

  it('o payload do PUT não contém nenhum dos 5 campos travados', () => {
    const data = {
      ...DEFAULT_FORM_VALUES,
      required_sex: 'F',
      required_professions: ['AT'],
      required_experience: '2 años',
      work_schedule: 'x',
      payment_day: 'Día 20',
    } as VacancyFormData;
    const full = buildVacancyPayload(data, 1, 'p-42', 'a-1');
    for (const f of ['required_sex', 'required_professions', 'required_experience', 'work_schedule', 'payment_day']) {
      expect(full).toHaveProperty(f);
    }
    const stripped = stripLockedFields(full, [...KNOWN_LOCKED_FIELDS]);
    for (const f of ['required_sex', 'required_professions', 'required_experience', 'work_schedule', 'payment_day']) {
      expect(stripped).not.toHaveProperty(f);
    }
  });
});
