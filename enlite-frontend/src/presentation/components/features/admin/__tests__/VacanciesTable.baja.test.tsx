import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacanciesTable, type VacancyRow } from '../VacanciesTable';
import { isBajaSelectable } from '../bajaSelectable';

const base = (o: Partial<VacancyRow>): VacancyRow => ({
  id: 'v', caseNumber: 817, caseOrdinal: null, status: 'Buscando AT', diasAberto: '01', stageCounts: {},
  postulados: '00', faltantes: '00', isDraft: false, lastActionAt: null, statusRaw: 'SEARCHING', hasService: false,
  talentumPauseState: null, ...o,
});

const ROWS: VacancyRow[] = [
  base({ id: 'sem-servico' }),
  base({ id: 'com-servico', hasService: true, caseOrdinal: 1 }),
  base({ id: 'baixada', status: 'Dada de baja', statusRaw: 'DE_BAJA' }),
  base({ id: 'manual', talentumPauseState: 'MANUAL_PAUSE' }),
];

describe('VacanciesTable — dar baixa e selo (spec 084 F1/F2/F4)', () => {
  it('P1: só vaga SEM serviço e não baixada é selecionável', () => {
    expect(ROWS.filter(isBajaSelectable).map((r) => r.id)).toEqual(['sem-servico', 'manual']);
  });

  it('com seleção ligada: checkbox só nas vagas selecionáveis; vaga de serviço e baixada NÃO têm', () => {
    render(<VacanciesTable vacancies={ROWS} selectedIds={new Set()} onToggleSelect={vi.fn()} onToggleAll={vi.fn()} />);
    expect(screen.getByTestId('vacancy-select-sem-servico')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-select-manual')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-select-com-servico')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-select-baixada')).not.toBeInTheDocument();
  });

  it('sem seleção (sem célula vacancy:update): nenhuma coluna de seleção', () => {
    render(<VacanciesTable vacancies={ROWS} />);
    expect(screen.queryByTestId('vacancies-select-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-select-sem-servico')).not.toBeInTheDocument();
  });

  it('clicar no checkbox seleciona e NÃO abre a vaga (stopPropagation); "selecionar todas" marca só as elegíveis', () => {
    const onToggleSelect = vi.fn();
    const onToggleAll = vi.fn();
    const onRowClick = vi.fn();
    render(
      <VacanciesTable vacancies={ROWS} onRowClick={onRowClick} selectedIds={new Set()} onToggleSelect={onToggleSelect} onToggleAll={onToggleAll} />,
    );
    fireEvent.click(screen.getByTestId('vacancy-select-sem-servico'));
    expect(onToggleSelect).toHaveBeenCalledWith('sem-servico');
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('vacancies-select-all'));
    expect(onToggleAll).toHaveBeenCalledWith(true);
  });

  it('vaga baixada tem o selo "Dada de baja" (só consulta); a lista manual do Talentum tem o seu selo', () => {
    render(<VacanciesTable vacancies={ROWS} />);
    expect(screen.getByTestId('vacancy-baja-badge-baixada')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-baja-badge-sem-servico')).not.toBeInTheDocument();
    expect(screen.getByTestId('vacancy-talentum-manual-badge-manual')).toBeInTheDocument();
  });

  it('R17: nenhuma ação de reativar na tabela', () => {
    render(<VacanciesTable vacancies={ROWS} selectedIds={new Set()} onToggleSelect={vi.fn()} onToggleAll={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /reactiv|reativ/i })).not.toBeInTheDocument();
  });
});
