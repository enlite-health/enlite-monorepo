import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JobFilters } from './JobFilters';
import { chooseCombo } from '@presentation/components/atoms/Combobox/testUtils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const OPCOES = [
  { value: '', label: 'Todos' },
  { value: 'zeta', label: 'Zeta' },
  { value: 'nandu', label: 'Ñandú' },
];

function montar() {
  const props = {
    tipoValue: '', localValue: '', areaValue: '', sexoValue: '',
    onTipoChange: vi.fn(), onLocalChange: vi.fn(), onAreaChange: vi.fn(), onSexoChange: vi.fn(),
    tipoOptions: OPCOES, localOptions: OPCOES, areaOptions: OPCOES, sexoOptions: OPCOES,
  };
  render(<JobFilters {...props} />);
  return props;
}

describe('JobFilters — 4 Combobox (spec 070)', () => {
  it('cada filtro é um combobox com o nome acessível do rótulo e escolher uma opção chama o onChange certo', () => {
    const p = montar();
    chooseCombo(screen.getByRole('combobox', { name: 'jobs.filterLabels.jobTypes' }), 'Zeta');
    chooseCombo(screen.getByRole('combobox', { name: 'jobs.filterLabels.workLocations' }), 'Ñandú');
    chooseCombo(screen.getByRole('combobox', { name: 'jobs.filterLabels.areas' }), 'Zeta');
    chooseCombo(screen.getByRole('combobox', { name: 'jobs.filterLabels.gender' }), 'Ñandú');
    expect(p.onTipoChange).toHaveBeenCalledWith('zeta');
    expect(p.onLocalChange).toHaveBeenCalledWith('nandu');
    expect(p.onAreaChange).toHaveBeenCalledWith('zeta');
    expect(p.onSexoChange).toHaveBeenCalledWith('nandu');
  });

  it('altura h-[60px] do seletor antigo (default) e a opção "Todos" (valor vazio) já na lista', () => {
    montar();
    const gatilho = screen.getByRole('combobox', { name: 'jobs.filterLabels.jobTypes' });
    expect(gatilho.className).toContain('h-[60px]');
    // valor '' = sem escolha: o gatilho mostra o placeholder (o nome do filtro), e a linha "Todos" está na lista
    expect(gatilho).toHaveTextContent('jobs.filterLabels.jobTypes');
    fireEvent.click(gatilho);
    expect(screen.getByRole('option', { name: 'Todos' })).toBeInTheDocument();
  });
});
