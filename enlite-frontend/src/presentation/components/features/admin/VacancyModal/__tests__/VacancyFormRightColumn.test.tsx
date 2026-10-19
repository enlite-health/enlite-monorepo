/**
 * VacancyFormRightColumn — "Horas semanales" da vaga (spec 056 T4.4): a soma vem de `weeklyHoursOf`
 * (a ÚNICA régua de horas do front), não de uma conta própria da coluna.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { VacancyFormRightColumn } from '../VacancyFormRightColumn';
import { DEFAULT_FORM_VALUES, type VacancyFormData } from '../../vacancy-form-schema';

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
