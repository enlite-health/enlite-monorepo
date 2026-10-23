import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminWorkerProfileFilters } from '../AdminWorkerProfileFilters';
import { INITIAL_PROFILE_FILTERS } from '../workerProfileFiltersConfig';
import { chooseCombo } from '@presentation/components/atoms/Combobox/testUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) =>
      typeof opts === 'string' ? opts : (opts as { defaultValue?: string } | undefined)?.defaultValue ?? key,
  }),
}));

const STATES = [
  { value: 'AR-B', label: 'Provincia de Buenos Aires' },
  { value: 'AR-C', label: 'Ciudad Autónoma de Buenos Aires' },
  { value: 'AR-X', label: 'Córdoba' },
];
const CITIES = [
  { value: 'La Matanza', label: 'La Matanza' },
  { value: 'Bosques', label: 'Bosques' },
];

function renderFilters(overrides: Partial<Parameters<typeof AdminWorkerProfileFilters>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <AdminWorkerProfileFilters
      filters={INITIAL_PROFILE_FILTERS}
      onChange={onChange}
      stateOptions={STATES}
      cityOptions={CITIES}
      experienceTypeOptions={[{ value: 'TEA', label: 'TEA' }]}
      preferredTypeOptions={[{ value: 'home', label: 'Domicilio' }]}
      {...overrides}
    />,
  );
  return { onChange };
}

describe('AdminWorkerProfileFilters', () => {
  it('renders the row with every filter label', () => {
    renderFilters();
    expect(screen.getByTestId('worker-profile-filters')).toBeInTheDocument();
    for (const label of ['Profesión', 'Rango etario', 'Idioma', 'Sexo', 'Provincia', 'Localidad', 'Días']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('short-list filters forward the chosen option to onChange', () => {
    const { onChange } = renderFilters();
    const combos = screen.getAllByRole('combobox');
    // profession(0), ageRange(1), experienceType(2), preferredType(3), language(4), sex(5), state(6), city(7), days(8)
    chooseCombo(combos[0], 'AT');
    chooseCombo(combos[1], 'Adultos');
    chooseCombo(combos[2], 'TEA');
    chooseCombo(combos[3], 'Domicilio');
    chooseCombo(combos[4], 'Portugués');
    chooseCombo(combos[5], 'Femenino');
    expect(onChange).toHaveBeenCalledWith({ profession: 'AT' });
    expect(onChange).toHaveBeenCalledWith({ preferredAgeRange: 'adults' });
    expect(onChange).toHaveBeenCalledWith({ experienceType: 'TEA' });
    expect(onChange).toHaveBeenCalledWith({ preferredType: 'home' });
    expect(onChange).toHaveBeenCalledWith({ language: 'pt' });
    expect(onChange).toHaveBeenCalledWith({ sex: 'female' });
  });

  it('Provincia is a searchable combobox: typing filters, picking calls onChange({ state }) (REQ-06)', async () => {
    const { onChange } = renderFilters();
    await userEvent.click(screen.getByTestId('filter-province'));
    expect(screen.getByRole('option', { name: 'Córdoba' })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Buscar...'), 'cordoba'); // sem acento
    expect(screen.queryByRole('option', { name: 'Provincia de Buenos Aires' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Córdoba' }).querySelector('button')!);
    expect(onChange).toHaveBeenCalledWith({ state: 'AR-X' });
  });

  it('Localidad is a searchable combobox: picking calls onChange({ city })', async () => {
    const { onChange } = renderFilters();
    await userEvent.click(screen.getByTestId('filter-locality'));
    await userEvent.click(screen.getByRole('option', { name: 'Bosques' }).querySelector('button')!);
    expect(onChange).toHaveBeenCalledWith({ city: 'Bosques' });
  });

  it('shows the selected province label on the combobox button', () => {
    renderFilters({ filters: { ...INITIAL_PROFILE_FILTERS, state: 'AR-C' } });
    expect(screen.getByTestId('filter-province')).toHaveTextContent('Ciudad Autónoma de Buenos Aires');
  });

  it('days multiselect forwards onChange({ days })', () => {
    const { onChange } = renderFilters();
    const combos = screen.getAllByRole('combobox');
    chooseCombo(combos[8], 'admin.vacancyDetail.vacancyForm.days.lun');
    expect(onChange).toHaveBeenCalledWith({ days: ['1'] });
  });
});
