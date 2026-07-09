import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EquipoArmadaSection } from '../EquipoArmadaSection';

// i18n mock — interpola {{count}}/{{con}}/{{sin}} para provar os números honestos.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, number>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) out += ` ${k}=${v}`;
      return out;
    },
  }),
}));

vi.mock('lucide-react', () => ({
  Info: (props: Record<string, unknown>) => <svg data-testid="icon-info" {...props} />,
}));

const horas = { totais: 12.5, aPreencher: 6, coberturaConSchedule: 3, coberturaSinSchedule: 2 };

describe('EquipoArmadaSection (estados honestos)', () => {
  it('mostra horas totais/a preencher e cobertura', () => {
    render(
      <EquipoArmadaSection
        equipoArmada={{ armados: 4, porArmar: 5, semConfig: 7, pendenteClasificacao: 2 }}
        horas={horas}
      />,
    );
    expect(screen.getByTestId('mgmt-equipo-armada')).toBeInTheDocument();
    expect(screen.getByText('12.5')).toBeInTheDocument(); // horas totais
    expect(screen.getByText('6')).toBeInTheDocument(); // horas a preencher
    expect(screen.getByText(/con=3 sin=2/)).toBeInTheDocument(); // cobertura
  });

  it('nunca mostra 0 falso: expõe "N sem classificação" e "N sem config"', () => {
    render(
      <EquipoArmadaSection
        equipoArmada={{ armados: 0, porArmar: 0, semConfig: 7, pendenteClasificacao: 2 }}
        horas={{ totais: 0, aPreencher: 0, coberturaConSchedule: 0, coberturaSinSchedule: 9 }}
      />,
    );
    expect(screen.getByText(/pendenteClasificacao count=2/)).toBeInTheDocument();
    expect(screen.getByText(/semConfig count=7/)).toBeInTheDocument();
  });
});
