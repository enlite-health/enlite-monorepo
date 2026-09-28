/**
 * ServiceTeamBoard — Quadro C (Fase 10, DX-10.10 (2)). 3 colunas CALCULADAS, sem arrasto,
 * botões de rejeitar/reverter com motivo obrigatório. Molde de i18n real:
 * `ServicosContratadosCard.test.tsx:9-20` — sem isso o enum cru escaparia (`expectNoRawEnumLeaks`).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ServiceTeamBoard } from '../ServiceTeamBoard';
import type { ServiceTeam } from '@domain/entities/ServiceTeam';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const NONAME_WORKER_ID = 'worker-sin-nombre-00001';

const TEAM: ServiceTeam = {
  serviceId: 'svc-1',
  vacancyId: 'vac-1',
  selected: [
    { workerId: 'w1', displayName: 'Ana Fixture', vacancyId: null },
    { workerId: NONAME_WORKER_ID, displayName: null, vacancyId: null },
  ],
  inService: [
    { workerId: 'w2', displayName: 'Beto Fixture', vacancyId: 'vac-1' },
  ],
  rejected: [
    { workerId: 'w3', displayName: 'Caco Fixture', vacancyId: null, reasonCategory: 'DESISTENCIA_DO_PRESTADOR' },
  ],
};

describe('ServiceTeamBoard — 3 colunas calculadas, sem arrasto, motivo obrigatório', () => {
  it('3 colunas com as contagens certas', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    expect(screen.getByTestId('kanban-column-SELECTED_FOR_SERVICE-count').textContent).toBe('2');
    expect(screen.getByTestId('kanban-column-IN_SERVICE-count').textContent).toBe('1');
    expect(screen.getByTestId('kanban-column-REJECTED_FOR_SERVICE-count').textContent).toBe('1');
  });

  it('um card por worker, nas três colunas', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    expect(screen.getByTestId('service-team-card-w1').textContent).toContain('Ana Fixture');
    expect(screen.getByTestId('service-team-card-w2').textContent).toContain('Beto Fixture');
    expect(screen.getByTestId('service-team-card-w3').textContent).toContain('Caco Fixture');
  });

  it('"Rechazar" só em Selecionado, "Revertir" só em Rejeitado, nenhum botão em Em Atendimento', () => {
    const { container } = render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    expect(screen.getByTestId('service-team-reject-w1')).toBeTruthy();
    expect(screen.queryByTestId('service-team-revert-w1')).toBeNull();

    expect(screen.queryByTestId('service-team-reject-w2')).toBeNull();
    expect(screen.queryByTestId('service-team-revert-w2')).toBeNull();

    expect(screen.getByTestId('service-team-revert-w3')).toBeTruthy();
    expect(screen.queryByTestId('service-team-reject-w3')).toBeNull();

    expectNoRawEnumLeaks(container);
  });

  it('displayName null mostra "sin nombre" com o final do workerId', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    const shortId = NONAME_WORKER_ID.slice(-8);
    const card = screen.getByTestId(`service-team-card-${NONAME_WORKER_ID}`);
    expect(card.textContent).toContain('sin nombre');
    expect(card.textContent).toContain(shortId);
  });

  it('Rejeitado mostra o motivo TRADUZIDO, nunca o enum cru', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    const card = screen.getByTestId('service-team-card-w3');
    expect(card.textContent).toContain('El prestador desistió');
    expect(card.textContent).not.toContain('DESISTENCIA_DO_PRESTADOR');
  });

  it('clique em "Rechazar" abre o modal com as 4 opções; confirmar desabilitado sem escolha; escolha + confirmar chama onReject', () => {
    const onReject = vi.fn();
    render(<ServiceTeamBoard team={TEAM} onReject={onReject} onRevert={vi.fn()} actionError={null} />);
    fireEvent.click(screen.getByTestId('service-team-reject-w1'));

    const modal = screen.getByTestId('service-team-reject-modal');
    expect(modal).toBeTruthy();
    expect(screen.getByTestId('service-team-reject-option-perfil-inadequado-ao-servico')).toBeTruthy();
    expect(screen.getByTestId('service-team-reject-option-indisponibilidade-de-horario')).toBeTruthy();
    expect(screen.getByTestId('service-team-reject-option-desistencia-do-prestador')).toBeTruthy();
    expect(screen.getByTestId('service-team-reject-option-other')).toBeTruthy();

    const confirm = screen.getByTestId('service-team-reject-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('service-team-reject-option-indisponibilidade-de-horario'));
    fireEvent.click(screen.getByTestId('service-team-reject-confirm'));

    expect(onReject).toHaveBeenCalledWith('w1', 'INDISPONIBILIDADE_DE_HORARIO');
    expect(screen.queryByTestId('service-team-reject-modal')).toBeNull();
  });

  it('clique em "Revertir" abre o modal com as 3 opções; escolha + confirmar chama onRevert', () => {
    const onRevert = vi.fn();
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={onRevert} actionError={null} />);
    fireEvent.click(screen.getByTestId('service-team-revert-w3'));

    expect(screen.getByTestId('service-team-revert-modal')).toBeTruthy();
    expect(screen.getByTestId('service-team-revert-option-reavaliacao')).toBeTruthy();
    expect(screen.getByTestId('service-team-revert-option-rejeitado-por-engano')).toBeTruthy();
    expect(screen.getByTestId('service-team-revert-option-other')).toBeTruthy();

    fireEvent.click(screen.getByTestId('service-team-revert-option-reavaliacao'));
    fireEvent.click(screen.getByTestId('service-team-revert-confirm'));

    expect(onRevert).toHaveBeenCalledWith('w3', 'REAVALIACAO');
  });

  it('erro da ação: aparece traduzido pelo código', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError="SERVICE_TEAM_WORKER_ALLOCATED" />);
    expect(screen.getByTestId('quadro-c-acao-erro').textContent).toBe('Quitá al prestador del itinerario antes de rechazarlo.');
  });

  it('sem erro: nenhum "quadro-c-acao-erro" na tela', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    expect(screen.queryByTestId('quadro-c-acao-erro')).toBeNull();
  });

  it('nenhum botão de "adicionar" (invariante 1 — o time é calculado, nunca criado à mão)', () => {
    render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    const nomes = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    for (const nome of nomes) expect(nome).not.toMatch(/adicionar|agregar|añadir|nuevo/i);
  });

  it('sem arrasto: nenhum card com aria-roledescription="draggable" habilitado (é o que o dnd-kit atribui a um item arrastável)', () => {
    const { container } = render(<ServiceTeamBoard team={TEAM} onReject={vi.fn()} onRevert={vi.fn()} actionError={null} />);
    expect(container.querySelectorAll('[aria-roledescription="draggable"]').length).toBe(0);
    const draggableWrapper = screen.getByTestId('kanban-draggable-w1');
    expect(draggableWrapper.getAttribute('data-drag-disabled')).toBe('true');
  });
});
