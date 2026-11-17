/**
 * TherapeuticProjectDiagnosisBlock (091, §9.8, DF-6): a peça de UM diagnóstico — Paso 3 (objetivos) e Paso 4
 * (atividades só dos objetivos marcados). A regra é da `TherapeuticCascade` (classe pura, T403): aqui se prova o
 * que o operador vê e clica, com a cascata REAL (sem mock da regra) e o i18n pt-BR real.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { TherapeuticCascade } from '@domain/entities/TherapeuticCascade';
import type { CascadeBlock, DiagnosisPlanSnapshot } from '@domain/entities/TherapeuticProject';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: Record<string, unknown>): string {
  const value = key.split('.').reduce<any>((acc, part) => acc?.[part], translations);
  if (typeof value !== 'string') return key;
  return opts ? value.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(opts[k] ?? _)) : value;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

import { TherapeuticProjectDiagnosisBlock, TherapeuticProjectDiagnosisBlockReadOnly } from '../TherapeuticProjectDiagnosisBlock';

const URI = 'urn:icd:X';
const OK: CascadeBlock = {
  diagnosisUri: URI,
  categoryCode: 'AB12',
  status: 'ok',
  objectives: [
    { id: 'o1', label: 'Objetivo um', description: 'Descrição um', activities: [{ id: 'a1', label: 'Atividade um', description: 'Descrição da atividade', suggestedFrequency: 'diária' }] },
    { id: 'o2', label: 'Objetivo dois', description: null, activities: [{ id: 'a2', label: 'Atividade dois', description: null, suggestedFrequency: null }] },
  ],
};

const cascadeOf = (block: CascadeBlock): TherapeuticCascade =>
  TherapeuticCascade.empty().chooseService('AT').withCatalog({ serviceCode: 'AT', serviceHasCatalog: true, blocks: [block] });

const montar = (block: CascadeBlock, cascade = cascadeOf(block), showIncomplete = false) => {
  const onToggleObjective = vi.fn();
  const onToggleActivity = vi.fn();
  render(
    <TherapeuticProjectDiagnosisBlock
      title="Diagnóstico X"
      block={block}
      cascade={cascade}
      showIncomplete={showIncomplete}
      onToggleObjective={onToggleObjective}
      onToggleActivity={onToggleActivity}
    />,
  );
  return { onToggleObjective, onToggleActivity };
};

describe('TherapeuticProjectDiagnosisBlock — bloco com catálogo (`ok`)', () => {
  it('mostra o título do diagnóstico e cada objetivo com título + descrição, nenhum marcado', () => {
    montar(OK);

    expect(screen.getByTestId(`tp-block-title-${URI}`)).toHaveTextContent('Diagnóstico X');
    expect(screen.getByText('Objetivo um')).toBeInTheDocument();
    expect(screen.getByText('Descrição um')).toBeInTheDocument();
    expect(screen.getByText(ptBR.therapeuticProjectForm.stepObjectives)).toBeInTheDocument();
    expect((screen.getByTestId(`tp-obj-${URI}-o1`) as HTMLInputElement).checked).toBe(false);
  });

  it('Paso 4 desabilitado sem objetivo marcado: `pickObjectiveFirst`, nenhuma atividade, fieldset disabled', () => {
    montar(OK);

    expect(screen.getByTestId(`tp-activities-${URI}`)).toBeDisabled();
    expect(screen.getByTestId(`tp-pick-objective-${URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.pickObjectiveFirst);
    expect(screen.queryByText('Atividade um')).not.toBeInTheDocument();
  });

  it('com o objetivo um marcado: habilita o Paso 4 e mostra SÓ as atividades dele, agrupadas, com descrição e frecuencia', () => {
    montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1'));

    const grupo = screen.getByTestId(`tp-activity-group-${URI}-o1`);
    expect(screen.getByTestId(`tp-activities-${URI}`)).not.toBeDisabled();
    expect(within(grupo).getByText('Atividade um')).toBeInTheDocument();
    expect(within(grupo).getByText('Descrição da atividade')).toBeInTheDocument();
    expect(within(grupo).getByText('Frequência: diária')).toBeInTheDocument();
    expect(screen.queryByText('Atividade dois')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`tp-pick-objective-${URI}`)).not.toBeInTheDocument();
  });

  it('clicar delega ao pai com o id do objetivo / da atividade (o bloco não guarda estado)', () => {
    const { onToggleObjective, onToggleActivity } = montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1'));

    fireEvent.click(screen.getByTestId(`tp-obj-${URI}-o2`));
    fireEvent.click(screen.getByTestId(`tp-act-${URI}-o1-a1`));

    expect(onToggleObjective).toHaveBeenCalledWith('o2');
    expect(onToggleActivity).toHaveBeenCalledWith('a1');
  });

  it('`planIncomplete` só aparece quando o pai manda mostrar', () => {
    montar(OK, cascadeOf(OK), true);

    expect(screen.getByTestId(`tp-plan-incomplete-${URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.planIncomplete);
  });

  it('sem `showIncomplete`, nenhum aviso de plano', () => {
    montar(OK);

    expect(screen.queryByTestId(`tp-plan-incomplete-${URI}`)).not.toBeInTheDocument();
  });
});

describe('TherapeuticProjectDiagnosisBlock — bloco sem catálogo', () => {
  it.each([['no_catalog'], ['no_category']] as const)('`%s`: aviso `noCatalog`, nenhuma escolha (nem objetivo, nem atividade)', (status) => {
    montar({ diagnosisUri: URI, categoryCode: null, status, objectives: [] });

    expect(screen.getByTestId(`tp-no-catalog-${URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.noCatalog);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByTestId(`tp-block-${URI}`)).toHaveAttribute('data-status', status);
  });
});

describe('TherapeuticProjectDiagnosisBlockReadOnly — snapshot congelado', () => {
  const PLANO: DiagnosisPlanSnapshot = {
    diagnosisUri: URI,
    categoryCode: 'AB12',
    objectives: [{ id: 'o1', label: 'Objetivo congelado', description: 'Descrição congelada' }],
    activities: [
      { id: 'a1', label: 'Atividade congelada', description: null, suggestedFrequency: 'semanal' },
      { id: 'a2', label: 'Sem frecuencia', description: null, suggestedFrequency: null },
    ],
  };

  it('lista objetivos e atividades como texto, com frecuencia só onde existe, e nenhum checkbox', () => {
    render(<TherapeuticProjectDiagnosisBlockReadOnly title="Diagnóstico X" plan={PLANO} />);

    expect(screen.getByText('Objetivo congelado')).toBeInTheDocument();
    expect(screen.getByText('Descrição congelada')).toBeInTheDocument();
    expect(screen.getByText('Frequência: semanal')).toBeInTheDocument();
    expect(screen.getAllByTestId('tp-activity-frequency')).toHaveLength(1);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('snapshot sem objetivos/atividades mostra "—", não uma lista vazia muda', () => {
    render(<TherapeuticProjectDiagnosisBlockReadOnly title="Diagnóstico X" plan={{ ...PLANO, objectives: [], activities: [] }} />);

    expect(screen.getByTestId(`tp-objectives-locked-${URI}`)).toHaveTextContent('—');
    expect(screen.getByTestId(`tp-activities-locked-${URI}`)).toHaveTextContent('—');
  });
});
