import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminWorkerProfileFilters } from '../AdminWorkerProfileFilters';
import { INITIAL_PROFILE_FILTERS } from '../workerProfileFiltersConfig';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) =>
      typeof opts === 'string' ? opts : (opts as { defaultValue?: string } | undefined)?.defaultValue ?? key,
  }),
}));

// MultiSelect tem teste próprio; aqui só precisamos do onChange chegar ao pai.
vi.mock('@presentation/components/atoms/MultiSelect', () => ({
  MultiSelect: ({ onChange }: { onChange: (v: string[]) => void }) => (
    <button type="button" data-testid="days-multiselect" onClick={() => onChange(['1', '3'])}>días</button>
  ),
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

  it('native selects (short lists) forward their value to onChange', async () => {
    const { onChange } = renderFilters();
    const selects = screen.getAllByRole('combobox');
    // profession(0), ageRange(1), experienceType(2), preferredType(3), language(4), sex(5)
    await userEvent.selectOptions(selects[0], 'AT');
    await userEvent.selectOptions(selects[1], 'adults');
    await userEvent.selectOptions(selects[2], 'TEA');
    await userEvent.selectOptions(selects[3], 'home');
    await userEvent.selectOptions(selects[4], 'pt');
    await userEvent.selectOptions(selects[5], 'female');
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
    await userEvent.click(screen.getByRole('option', { name: 'Córdoba' }));
    expect(onChange).toHaveBeenCalledWith({ state: 'AR-X' });
  });

  it('Localidad is a searchable combobox: picking calls onChange({ city })', async () => {
    const { onChange } = renderFilters();
    await userEvent.click(screen.getByTestId('filter-locality'));
    await userEvent.click(screen.getByRole('option', { name: 'Bosques' }));
    expect(onChange).toHaveBeenCalledWith({ city: 'Bosques' });
  });

  it('shows the selected province label on the combobox button', () => {
    renderFilters({ filters: { ...INITIAL_PROFILE_FILTERS, state: 'AR-C' } });
    expect(screen.getByTestId('filter-province')).toHaveTextContent('Ciudad Autónoma de Buenos Aires');
  });

  it('days multiselect forwards onChange({ days })', () => {
    const { onChange } = renderFilters();
    fireEvent.click(screen.getByTestId('days-multiselect'));
    expect(onChange).toHaveBeenCalledWith({ days: ['1', '3'] });
  });
});
