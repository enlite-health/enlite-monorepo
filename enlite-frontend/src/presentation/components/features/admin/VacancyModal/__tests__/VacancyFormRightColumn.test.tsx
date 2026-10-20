/**
 * VacancyFormRightColumn — "Horas semanales" da vaga (spec 056 T4.4): a soma vem de `weeklyHoursOf`
 * (a ÚNICA régua de horas do front), não de uma conta própria da coluna.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { VacancyFormRightColumn } from '../VacancyFormRightColumn';
import { DEFAULT_FORM_VALUES, type VacancyFormData } from '../../vacancy-form-schema';
import { lockedFormFields } from '../../vacancyLockedFields';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/molecules/ServiceAreaMap', () => ({ ServiceAreaMap: () => null }));

function Harness({ schedule }: { schedule: VacancyFormData['schedule'] }) {
  const { register, control, formState: { errors } } = useForm<VacancyFormData>({
    defaultValues: { ...DEFAULT_FORM_VALUES, schedule },
  });
  return (
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
    />
  );
}

describe('VacancyFormRightColumn — horas semanais', () => {
  it('20:00-08:00 mostra 12', () => {
    render(<Harness schedule={[{ days: ['sab'], timeFrom: '20:00', timeTo: '08:00' }]} />);
    expect(screen.getByTestId('weekly-hours-display').textContent).toBe('12');
  });

  it('Fin = Inicio conta 24 h (regra única)', () => {
    render(<Harness schedule={[{ days: ['lun'], timeFrom: '08:00', timeTo: '08:00' }]} />);
    expect(screen.getByTestId('weekly-hours-display').textContent).toBe('24');
  });

  it('sem horário: traço', () => {
    render(<Harness schedule={[]} />);
    expect(screen.getByTestId('weekly-hours-display').textContent).toBe('—');
  });
});

function ProvidersHarness({ onReady }: { onReady: (getValues: () => VacancyFormData) => void }) {
  const { register, control, getValues, formState: { errors } } = useForm<VacancyFormData>({
    defaultValues: { ...DEFAULT_FORM_VALUES, providers_needed: 2 },
  });
  onReady(getValues);
  return (
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
      lockedFields={lockedFormFields([])}
      patientId="p-1"
    />
  );
}

describe('VacancyFormRightColumn — quantidade de prestadores (058 B)', () => {
  it('setValueAs: campo vazio vira null (não NaN) e "3" vira 3', () => {
    let getValues!: () => VacancyFormData;
    render(<ProvidersHarness onReady={(g) => { getValues = g; }} />);
    const input = screen.getByTestId('providers-needed-input');
    fireEvent.change(input, { target: { value: '' } });
    expect(getValues().providers_needed).toBeNull();
    fireEvent.change(input, { target: { value: '3' } });
    expect(getValues().providers_needed).toBe(3);
  });
});
