/**
 * PatientKanbanCard — o desempate do lead sem nome.
 *
 * O formulário público não colhe nome (`2026-07-27a#DEC-02`), então os 10 leads
 * em produção têm todos `first_name='Solicitante'` e o board fica com caixas
 * indistinguíveis — problema real de quem precisa ligar dentro das 24h de SLA.
 *
 * O card passou a mostrar o contato MASCARADO. Este arquivo prende as condições
 * do parecer do lex de 30/08 que só existem no DOM:
 *
 *   C3  `data-clarity-mask` no elemento — o Clarity grava as sessões do painel
 *   C6  contato de responsável vem rotulado como tal, nos dois idiomas
 *
 * A máscara em si é do SERVIDOR (C1) — o card não mascara nada, e é isso que os
 * dois primeiros testes prendem: o componente exibe o que recebeu, sem regra.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { PatientKanbanCard } from '../PatientKanbanCard';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

function lead(overrides: Partial<PatientKanbanItem> = {}): PatientKanbanItem {
  return {
    id: 'lead-1',
    firstName: 'Solicitante',
    lastName: null,
    caseNumber: null,
    dependencyLevel: null,
    status: 'SOLICITANTE',
    leadContactEmailMasked: 'jo***@gmail.com',
    leadContactIsResponsible: false,
    ...overrides,
  };
}

const renderCard = (p: PatientKanbanItem) =>
  render(<MemoryRouter><PatientKanbanCard patient={p} /></MemoryRouter>);

beforeEach(() => {
  i18n.addResourceBundle('es', 'translation', es, true, true);
  i18n.addResourceBundle('pt-BR', 'translation', ptBR, true, true);
});

describe('o que desempata os cards', () => {
  it('mostra o contato mascarado que o servidor mandou', () => {
    renderCard(lead());
    expect(screen.getByTestId('patient-kanban-card-lead-1-contact')).toHaveTextContent('jo***@gmail.com');
  });

  it('sem contato (ficha com nome real) não renderiza elemento nenhum', () => {
    renderCard(lead({ firstName: 'Ana', lastName: 'García', leadContactEmailMasked: null }));
    expect(screen.queryByTestId('patient-kanban-card-lead-1-contact')).toBeNull();
  });

  it('o card NÃO mascara — exibe exatamente o recebido, sem tocar no valor', () => {
    // Se algum dia o servidor regredir e mandar o endereço cru, o card mostra
    // cru. É proposital: a trava é do servidor (C1), e mascarar aqui também
    // esconderia a regressão de quem revisa.
    renderCard(lead({ leadContactEmailMasked: 'jo***@gmail.com' }));
    const el = screen.getByTestId('patient-kanban-card-lead-1-contact');
    expect(el.textContent).toBe('jo***@gmail.com');
  });
});

describe('hierarquia: o contato é a identidade, não um rodapé', () => {
  it('com contato, o TÍTULO é o contato — a palavra "Solicitante" não aparece', () => {
    // A coluna já se chama "Solicitante". Repetir a palavra em negrito escuro em
    // cada card empurrava para cinza de 11px a única coisa que os distingue.
    renderCard(lead());
    const card = screen.getByTestId('patient-kanban-card-lead-1');
    expect(card).toHaveTextContent('jo***@gmail.com');
    expect(card).not.toHaveTextContent('Solicitante');
  });

  it('o contato é o alvo de clique que abre a ficha', () => {
    renderCard(lead());
    const abrir = screen.getByTestId('patient-kanban-card-lead-1-open');
    expect(abrir).toHaveTextContent('jo***@gmail.com');
  });

  it('SEM contato, o título volta a ser o nome — nada quebra', () => {
    renderCard(lead({ firstName: 'Ana', lastName: 'García', leadContactEmailMasked: null }));
    const card = screen.getByTestId('patient-kanban-card-lead-1');
    expect(card).toHaveTextContent('Ana García');
  });

  it('lead sem contato nenhum ainda mostra o placeholder — degradação, não tela vazia', () => {
    renderCard(lead({ leadContactEmailMasked: null }));
    expect(screen.getByTestId('patient-kanban-card-lead-1')).toHaveTextContent('Solicitante');
  });
});

describe('C3 — o Clarity não pode gravar o contato', () => {
  it('o contato está dentro de um elemento com data-clarity-mask', () => {
    renderCard(lead());
    const contato = screen.getByTestId('patient-kanban-card-lead-1-contact');
    expect(contato.closest('[data-clarity-mask="True"]')).not.toBeNull();
  });
});

describe('C6 — de quem é o contato', () => {
  it('contato do PACIENTE não leva rótulo', () => {
    renderCard(lead({ leadContactIsResponsible: false }));
    expect(screen.queryByTestId('patient-kanban-card-lead-1-contact-responsible')).toBeNull();
  });

  it('contato do RESPONSÁVEL vem rotulado — es', async () => {
    await i18n.changeLanguage('es');
    renderCard(lead({ leadContactIsResponsible: true }));
    expect(screen.getByTestId('patient-kanban-card-lead-1-contact-responsible'))
      .toHaveTextContent('Contacto del responsable');
  });

  it('contato do RESPONSÁVEL vem rotulado — pt-BR', async () => {
    await i18n.changeLanguage('pt-BR');
    renderCard(lead({ leadContactIsResponsible: true }));
    expect(screen.getByTestId('patient-kanban-card-lead-1-contact-responsible'))
      .toHaveTextContent('Contato do responsável');
  });
});
