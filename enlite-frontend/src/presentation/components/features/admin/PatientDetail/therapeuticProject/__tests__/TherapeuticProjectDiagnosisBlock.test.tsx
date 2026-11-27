/**
 * TherapeuticProjectDiagnosisBlock (091, §9.8, DF-6): a peça de UM diagnóstico — Paso 3 (objetivos) e Paso 4
 * (atividades só dos objetivos marcados). A regra é da `TherapeuticCascade` (classe pura, T403): aqui se prova o
 * que o operador vê e clica, com a cascata REAL (sem mock da regra) e o i18n pt-BR real.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { TherapeuticCascade } from '@domain/entities/TherapeuticCascade';
import type { CascadeBlock, DiagnosisPlanSnapshot } from '@domain/entities/TherapeuticProject';

const translations = ptBR as Record<string, any>;
const lookup = (key: string): unknown => key.split('.').reduce<any>((acc, part) => acc?.[part], translations);
/** Plural como o i18next: `_zero` quando count=0 e existir; senão `_one`/`_other` pelo Intl.PluralRules do pt-BR. */
function pluralKey(key: string, count: number): string {
  if (count === 0 && typeof lookup(`${key}_zero`) === 'string') return `${key}_zero`;
  return `${key}_${new Intl.PluralRules('pt-BR').select(count)}`;
}
function t(key: string, opts?: Record<string, unknown>): string {
  const resolved = typeof opts?.count === 'number' && typeof lookup(key) !== 'string' ? pluralKey(key, opts.count) : key;
  const value = lookup(resolved);
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

const montar = (block: CascadeBlock, cascade = cascadeOf(block), showIncomplete = false, defaultOpen = true) => {
  const onToggleObjective = vi.fn();
  const onToggleActivity = vi.fn();
  render(
    <TherapeuticProjectDiagnosisBlock
      title="Diagnóstico X"
      block={block}
      cascade={cascade}
      showIncomplete={showIncomplete}
      defaultOpen={defaultOpen}
      onToggleObjective={onToggleObjective}
      onToggleActivity={onToggleActivity}
    />,
  );
  return { onToggleObjective, onToggleActivity };
};

const pill = () => screen.getByTestId(`tp-block-pill-${URI}`);
const tf = ptBR.therapeuticProjectForm;

describe('TherapeuticProjectDiagnosisBlock — acordeão (099)', () => {
  it('`defaultOpen`: abre com `aria-expanded=true` e mostra os cartões; fechado não monta o corpo; o clique alterna', () => {
    montar(OK);
    expect(screen.getByTestId(`tp-block-toggle-${URI}`)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId(`tp-obj-${URI}-o1`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`tp-block-toggle-${URI}`));

    expect(screen.getByTestId(`tp-block-toggle-${URI}`)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId(`tp-obj-${URI}-o1`)).not.toBeInTheDocument();
  });

  it('sem `defaultOpen` nasce fechado (só o 1º diagnóstico é aberto pelo formulário)', () => {
    montar(OK, cascadeOf(OK), false, false);

    expect(screen.getByTestId(`tp-block-toggle-${URI}`)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId(`tp-obj-${URI}-o1`)).not.toBeInTheDocument();
  });
});

describe('TherapeuticProjectDiagnosisBlock — bloco com catálogo (`ok`)', () => {
  it('mostra o título, o contador e cada objetivo como cartão-botão (título + descrição + N atividades), nenhum marcado', () => {
    montar(OK);

    expect(screen.getByTestId(`tp-block-title-${URI}`)).toHaveTextContent('Diagnóstico X');
    expect(screen.getByTestId(`tp-block-counter-${URI}`)).toHaveTextContent('0 objetivos · 0 atividades');
    expect(screen.getByText('Objetivo um')).toBeInTheDocument();
    expect(screen.getByText('Descrição um')).toBeInTheDocument();
    const cartao = screen.getByTestId(`tp-obj-${URI}-o1`);
    expect(cartao.tagName).toBe('BUTTON');
    expect(cartao).toHaveAttribute('aria-pressed', 'false');
    expect(cartao).toHaveTextContent('1 atividade');
  });

  it('a pílula mostra os 4 estados: Sem elegir, Falta una actividad, Completo e Sem catálogo', () => {
    montar(OK);
    expect(pill()).toHaveTextContent(tf.pillNoneChosen);
    cleanup();

    montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1'));
    expect(pill()).toHaveTextContent(tf.pillMissingActivity);
    cleanup();

    montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1').toggleActivity(URI, 'a1'));
    expect(pill()).toHaveTextContent(tf.pillComplete);
    cleanup();

    montar({ diagnosisUri: URI, categoryCode: null, status: 'no_catalog', objectives: [] });
    expect(pill()).toHaveTextContent(tf.pillNoCatalog);
  });

  it('sem objetivo marcado NENHUMA atividade aparece (nada vem pré-marcado, DD-13)', () => {
    montar(OK);

    expect(screen.queryByText('Atividade um')).not.toBeInTheDocument();
    expect(screen.queryByText(tf.activitiesOfObjective)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
  });

  it('com o objetivo um marcado: as atividades dele aparecem DENTRO do cartão, empilhadas, com descrição e frecuencia; as do dois não', () => {
    montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1'));

    const grupo = screen.getByTestId(`tp-activity-group-${URI}-o1`);
    expect(grupo.parentElement).toContainElement(screen.getByTestId(`tp-obj-${URI}-o1`));
    expect(within(grupo).getByText(tf.activitiesOfObjective)).toBeInTheDocument();
    expect(within(grupo).getByText('Atividade um')).toBeInTheDocument();
    expect(within(grupo).getByText('Descrição da atividade')).toBeInTheDocument();
    expect(within(grupo).getByText('Frequência: diária')).toBeInTheDocument();
    expect(grupo.querySelector('.grid')).toBeNull(); // coluna, não grade
    expect(screen.queryByText('Atividade dois')).not.toBeInTheDocument();
    expect(screen.getByTestId(`tp-obj-${URI}-o1`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`tp-act-${URI}-o1-a1`)).toHaveAttribute('aria-pressed', 'false');
  });

  it('"N de M elegidas" no cartão marcado e "N actividad(es)" no desmarcado; contador do cabeçalho segue', () => {
    montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1').toggleActivity(URI, 'a1'));

    expect(screen.getByTestId(`tp-obj-${URI}-o1`)).toHaveTextContent('1 de 1 escolhidas');
    expect(screen.getByTestId(`tp-obj-${URI}-o2`)).toHaveTextContent('1 atividade');
    expect(screen.getByTestId(`tp-act-${URI}-o1-a1`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`tp-block-counter-${URI}`)).toHaveTextContent('1 objetivo · 1 atividade');
  });

  it('desmarcar o objetivo tira as atividades dele da tela (a regra é da cascata)', () => {
    const marcado = cascadeOf(OK).toggleObjective(URI, 'o1').toggleActivity(URI, 'a1');
    montar(OK, marcado.toggleObjective(URI, 'o1'));

    expect(screen.queryByText('Atividade um')).not.toBeInTheDocument();
    expect(screen.getByTestId(`tp-obj-${URI}-o1`)).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicar delega ao pai com o id do objetivo / da atividade (o bloco não guarda estado de seleção)', () => {
    const { onToggleObjective, onToggleActivity } = montar(OK, cascadeOf(OK).toggleObjective(URI, 'o1'));

    fireEvent.click(screen.getByTestId(`tp-obj-${URI}-o2`));
    fireEvent.click(screen.getByTestId(`tp-act-${URI}-o1-a1`));

    expect(onToggleObjective).toHaveBeenCalledWith('o2');
    expect(onToggleActivity).toHaveBeenCalledWith('a1');
  });

  it('`planIncomplete` só aparece quando o pai manda mostrar (role=alert)', () => {
    montar(OK, cascadeOf(OK), true);

    expect(screen.getByTestId(`tp-plan-incomplete-${URI}`)).toHaveTextContent(tf.planIncomplete);
    expect(screen.getByRole('alert')).toBe(screen.getByTestId(`tp-plan-incomplete-${URI}`));
  });

  it('sem `showIncomplete`, nenhum aviso de plano', () => {
    montar(OK);

    expect(screen.queryByTestId(`tp-plan-incomplete-${URI}`)).not.toBeInTheDocument();
  });
});

describe('TherapeuticProjectDiagnosisBlock — bloco sem catálogo', () => {
  it.each([['no_catalog'], ['no_category']] as const)('`%s`: aviso `noCatalog`, contador "Sem objetivos", nenhuma escolha', (status) => {
    montar({ diagnosisUri: URI, categoryCode: null, status, objectives: [] });

    expect(screen.getByTestId(`tp-no-catalog-${URI}`)).toHaveTextContent(tf.noCatalog);
    expect(screen.getByTestId(`tp-block-counter-${URI}`)).toHaveTextContent(tf.noObjectivesToPick);
    expect(pill()).toHaveTextContent(tf.pillNoCatalog);
    expect(screen.queryAllByRole('button', { pressed: false })).toHaveLength(0);
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
