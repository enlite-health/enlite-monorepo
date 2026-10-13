/**
 * EnquadreStates — os 17 estados do protótipo do enquadre (spec 052, Fase 0), com os MESMOS datasets do harness
 * (`src/preview/enquadre/datasets.ts`) e os mesmos cliques que abrem o drawer/diálogo/painel (`autoSteps.ts`).
 * Só este teste importa o harness; a produção não. Idioma: es (o do print).
 *
 * ARRASTO: o dnd-kit não dispara drop em jsdom (convenção de KanbanBoard.drop.test.tsx). O wrapper do mock abaixo
 * deixa o `KanbanBoardShell` REAL renderizar e captura o `onDrop` que ele recebe — o mesmo callback que o
 * `handleDragEnd` do shell invoca ao soltar. Nada de arrasto simulado por ponteiro.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { KanbanBoard } from '@presentation/components/features/admin/Kanban/KanbanBoard';
import type { KanbanDropEvent } from '@presentation/components/features/admin/Kanban/KanbanBoardShell';
import { tabsVisibleFor } from '@presentation/hooks/useCellAccess';
import { screenById } from '@presentation/config/screenRegistry';
import { VACANCY_TABS } from '@presentation/components/features/admin/VacancyDetail/vacancyTabs';
import type { EnquadreParticipant } from '@domain/entities/EnquadreEvent';
import { runAutoSteps } from '../../../../../../../preview/enquadre/autoSteps';
import { datasetById, installDataset } from '../../../../../../../preview/enquadre/datasets';
import { StateRoot } from '../../../../../../../preview/enquadre/PreviewShell';
import { funnelStages } from '../../../../../../../preview/enquadre/fixtures';

let capturedOnDrop: ((e: KanbanDropEvent<EnquadreParticipant>) => void) | null = null;
vi.mock('@presentation/components/features/admin/Kanban/KanbanBoardShell', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@presentation/components/features/admin/Kanban/KanbanBoardShell')>();
  const Real = mod.KanbanBoardShell;
  const { createElement } = await import('react');
  return {
    ...mod,
    KanbanBoardShell: (props: { onDrop: (e: KanbanDropEvent<EnquadreParticipant>) => void } & Record<string, unknown>) => {
      capturedOnDrop = props.onDrop;
      return createElement(Real as never, props as never);
    },
  };
});

let restore: (() => void) | null = null;
const user = { click: (el: Element): Promise<void> => userEvent.click(el) };
const q = (id: string): HTMLElement => screen.getByTestId(id);
const text = (id: string): string => q(id).textContent ?? '';
const count = (col: string): number => Number(text(`kanban-column-${col}-count`));
const columnIds = (): string[] => Array.from(document.querySelectorAll('[data-testid^="kanban-column-"]')).map((e) => e.getAttribute('data-testid') ?? '').filter((id) => /^kanban-column-[A-Z_]+$/.test(id));
const columnCounts = (): Record<string, number> => Object.fromEntries(['CONVOKED', 'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED'].map((c) => [c, count(c)]));

/**
 * Roda os passos do harness (cliques reais + espera por data-testid) FORA do `act`: dentro dele o React só descarrega as
 * atualizações ao sair e a espera por elemento nunca veria o resultado (é o que o `waitFor` do RTL também faz).
 */
async function runSteps(id: string): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try { await runAutoSteps(id); } finally { env.IS_REACT_ACT_ENVIRONMENT = true; }
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 60); }); }); // descarrega recargas pendentes
}

async function mount(id: string, steps = true): Promise<void> {
  restore = installDataset(id);
  const ds = datasetById(id)!;
  render(<MemoryRouter><StateRoot dataset={ds} /></MemoryRouter>);
  if (ds.root !== 'funnel') {
    await screen.findByTestId('enquadre-unassigned-count');
    await waitFor(() => expect(screen.queryByTestId('enquadre-loading')).not.toBeInTheDocument());
  }
  if (steps) await runSteps(id);
}

beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => { cleanup(); restore?.(); restore = null; capturedOnDrop = null; });

describe('Lista de eventos (E1-E5, E12, E15)', () => {
  it('E1 barra de abas real com 5 abas: Reclutamiento e Encuadre, Encuadre ativa, lista embaixo', async () => {
    await mount('01');
    const tabs = screen.getAllByRole('button').filter((b) => b.getAttribute('data-testid')?.startsWith('vacancy-tab-'));
    expect(tabs.map((b) => b.getAttribute('data-testid'))).toEqual(['vacancy-tab-encuadres', 'vacancy-tab-enquadre', 'vacancy-tab-talentum', 'vacancy-tab-links', 'vacancy-tab-notes']);
    expect(text('vacancy-tab-encuadres')).toBe('Reclutamiento');
    expect(text('vacancy-tab-enquadre')).toBe('Encuadre');
    expect(q('vacancy-tab-enquadre').className).toContain('bg-primary');
    expect(q('enquadre-events-table')).toBeInTheDocument();
  });

  it('E1 tabsVisibleFor mostra a aba `enquadre` sem container, com o engine ligado e sem nenhuma permissão', () => {
    const visible = tabsVisibleFor(screenById('vacancies.detail'), VACANCY_TABS, [], 'on');
    expect(visible).toContain('enquadre');
    expect(visible).not.toContain('encuadres');
  });

  it('E2 lista vazia: "Todavía no hay eventos", botão de criar e contador 3', async () => {
    await mount('02');
    expect(text('enquadre-empty')).toContain('Todavía no hay eventos');
    expect(q('enquadre-empty-create-button')).toBeInTheDocument();
    expect(q('enquadre-unassigned-count').getAttribute('data-count')).toBe('3');
    expect(text('enquadre-unassigned-count')).toBe('3 completados sin evento');
  });

  it('E3 próximos: 2 eventos agendados com Meet, 5 e 4 convocados', async () => {
    await mount('03');
    expect(q('enquadre-event-row-ev-01').getAttribute('data-phase')).toBe('scheduled');
    expect(q('enquadre-event-row-ev-02').getAttribute('data-phase')).toBe('scheduled');
    expect(text('enquadre-event-convoked-ev-01')).toBe('5');
    expect(text('enquadre-event-convoked-ev-02')).toBe('4');
    expect(text('enquadre-event-date-ev-01')).toBe('16/10');
    expect(text('enquadre-event-time-ev-01')).toBe('14:00');
    expect(q('enquadre-event-meet-ev-01')).toBeInTheDocument();
    expect(q('enquadre-event-meet-ev-02')).toBeInTheDocument();
  });

  it('E4 pendente de encerrar: linha em destaque em primeiro, "2 marcados de 6", sem Meet', async () => {
    await mount('04');
    const rows = screen.getAllByTestId(/^enquadre-event-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('enquadre-event-row-ev-03');
    expect(rows[0].getAttribute('data-phase')).toBe('pending_close');
    expect(rows[0].className).toContain('bg-amber-50');
    expect(text('enquadre-event-marked-ev-03')).toBe('2 marcados de 6');
    expect(text('enquadre-event-phase-ev-03')).toBe('Pendiente de cierre');
    expect(screen.queryByTestId('enquadre-event-meet-ev-03')).not.toBeInTheDocument();
  });

  it('E5 encerrados no fim, com o resultado por extenso e sem Meet', async () => {
    await mount('05');
    const order = screen.getAllByTestId(/^enquadre-event-row-/).map((r) => r.getAttribute('data-testid'));
    expect(order).toEqual(['enquadre-event-row-ev-03', 'enquadre-event-row-ev-01', 'enquadre-event-row-ev-02', 'enquadre-event-row-ev-04', 'enquadre-event-row-ev-05']);
    const outcome = text('enquadre-event-outcome-ev-04');
    ['Seleccionados: 2', 'Respuesta rápida: 1', 'Rechazados: 1', 'Devueltos: 1'].forEach((s) => expect(outcome).toContain(s));
    expect(q('enquadre-event-row-ev-04').getAttribute('data-phase')).toBe('closed');
    expect(screen.queryByTestId('enquadre-event-meet-ev-04')).not.toBeInTheDocument();
  });

  it('E12 quatro linhas encerradas, cada uma com os selos da esteira (aguardando, feita+pronto, bloqueado com o porquê, indisponível)', async () => {
    await mount('12');
    expect(screen.getAllByTestId(/^enquadre-seals-/)).toHaveLength(4);
    expect([text('enquadre-seal-import-chip-ev-71'), text('enquadre-seal-summary-chip-ev-71')]).toEqual(['Esperando', 'Esperando']);
    expect([text('enquadre-seal-import-chip-ev-72'), text('enquadre-seal-summary-chip-ev-72')]).toEqual(['Importada', 'Resumen listo']);
    expect(text('enquadre-seal-import-chip-ev-73')).toBe('Bloqueada');
    expect(text('enquadre-seal-blocked-reason-ev-73')).toContain('Falta confirmar la identidad');
    expect([text('enquadre-seal-import-chip-ev-74'), text('enquadre-seal-summary-chip-ev-74')]).toEqual(['Importada', 'Resumen no disponible']);
    expect(q('enquadre-seal-import-chip-ev-72').getAttribute('data-tone')).toBe('ok');
    expect(q('enquadre-seal-import-chip-ev-73').getAttribute('data-tone')).toBe('bad');
  });

  it('E14/E15 cancelar: contador 3 antes e 8 depois; o evento vira "Cancelado", no fim, sem Meet nem ações', async () => {
    await mount('15', false);
    expect(q('enquadre-unassigned-count').getAttribute('data-count')).toBe('3');
    await runSteps('15');
    await waitFor(() => expect(q('enquadre-unassigned-count').getAttribute('data-count')).toBe('8'));
    expect(q('enquadre-event-row-ev-01').getAttribute('data-phase')).toBe('cancelled');
    expect(text('enquadre-event-phase-ev-01')).toBe('Cancelado');
    expect(screen.queryByTestId('enquadre-event-meet-ev-01')).not.toBeInTheDocument();
    const order = screen.getAllByTestId(/^enquadre-event-row-/).map((r) => r.getAttribute('data-testid'));
    expect(order[order.length - 1]).toBe('enquadre-event-row-ev-01');
  });
});

describe('Drawer de criar evento (E6-E8)', () => {
  it('E6 drawer padrão: entrevistadora sem vínculo desabilitada com o motivo, 5 prestadores, 3 horários livres, duração 60', async () => {
    await mount('06');
    expect(q('enquadre-create-drawer')).toBeInTheDocument();
    expect(q('enquadre-create-host-h-c').getAttribute('data-disabled')).toBe('true');
    expect(text('enquadre-create-host-reason-h-c')).toContain('Sin vínculo');
    expect(q('enquadre-create-host-h-a').getAttribute('data-disabled')).toBe('false');
    expect((q('enquadre-create-duration-input') as HTMLInputElement).value).toBe('60');
    expect(['09:00', '11:30', '15:00'].every((s) => screen.queryByTestId(`enquadre-create-slot-${s}`))).toBe(true);
    expect(screen.getAllByTestId(/^enquadre-create-worker-option-/)).toHaveLength(5);
  });

  it('E6 "Crear" só habilita com entrevistador + data + hora + ≥ 1 prestador', async () => {
    await mount('06');
    const submit = q('enquadre-create-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // entrevistador + data, sem hora nem prestador
    await user.click(q('enquadre-create-slot-15:00'));
    expect(submit.disabled).toBe(true); // + hora, sem prestador
    expect(q('enquadre-create-slot-15:00').getAttribute('aria-pressed')).toBe('true');
    expect((q('enquadre-create-time-input') as HTMLInputElement).value).toBe('15:00');
    await user.click(q('enquadre-create-worker-checkbox-w-21'));
    expect(submit.disabled).toBe(false); // os 4 requisitos
    await user.click(q('enquadre-create-worker-checkbox-w-21'));
    expect(submit.disabled).toBe(true);
  });

  it('E7 erro do Google: o drawer não fecha, a seleção fica e o texto diz que nada foi gravado', async () => {
    await mount('07');
    expect(q('enquadre-create-drawer')).toBeInTheDocument();
    expect(text('enquadre-create-error')).toContain('No se guardó nada');
    expect(q('enquadre-create-selected-count').getAttribute('data-count')).toBe('2');
    expect((q('enquadre-create-worker-checkbox-w-21') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('enquadre-event-row-ev-new-1')).not.toBeInTheDocument();
  });

  it('E8 prestador sem e-mail: caixa desabilitada, motivo escrito e não selecionável', async () => {
    await mount('08');
    expect(q('enquadre-create-worker-option-w-26').getAttribute('data-disabled')).toBe('true');
    expect(text('enquadre-create-worker-reason-w-26')).toBe('Sin e-mail válido: no se puede convocar');
    expect((q('enquadre-create-worker-checkbox-w-26') as HTMLInputElement).disabled).toBe(true);
    await user.click(q('enquadre-create-worker-checkbox-w-26'));
    expect(q('enquadre-create-selected-count').getAttribute('data-count')).toBe('1'); // só o w-21 do passo
  });

  it('E6 sucesso: fecha o drawer e recarrega a lista (evento novo)', async () => {
    await mount('06');
    await user.click(q('enquadre-create-slot-15:00'));
    await user.click(q('enquadre-create-worker-checkbox-w-21'));
    await user.click(q('enquadre-create-submit'));
    await waitFor(() => expect(screen.queryByTestId('enquadre-create-drawer')).not.toBeInTheDocument());
    expect(await screen.findByTestId('enquadre-event-row-ev-new-1')).toBeInTheDocument();
  });
});

describe('Kanban do evento (E9-E11)', () => {
  it('E9 evento aberto: 5 cards em Convocados, 0 nas outras; encerrar desabilitado com o motivo escrito', async () => {
    await mount('09');
    expect(columnCounts()).toEqual({ CONVOKED: 5, SELECTED: 0, QUICK_RESPONSE_TEAM: 0, REJECTED: 0 });
    const close = q('enquadre-kanban-close') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.getAttribute('data-disabled')).toBe('true');
    expect(close.getAttribute('title')).toBe('Disponible cuando termine el horario del evento');
    expect(close.getAttribute('aria-describedby')).toBe(q('enquadre-kanban-close-blocked').id);
    expect(screen.getAllByTestId('move-to-button')).toHaveLength(5);
    expect(screen.getAllByTestId('reject-button')).toHaveLength(5);
    expect(screen.queryByTestId('notes-button')).not.toBeInTheDocument();
  });

  it('E9 "Mover a…" oferece Seleccionados e Respuesta rápida (o atual some; sem Rechazados)', async () => {
    await mount('09');
    await user.click(within(q('enquadre-participant-p-01')).getByTestId('move-to-button'));
    expect(screen.getByTestId('move-to-option-SELECTED')).toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-QUICK_RESPONSE_TEAM')).toBeInTheDocument();
    expect(screen.queryByTestId('move-to-option-CONVOKED')).not.toBeInTheDocument();
    expect(screen.queryByTestId('move-to-option-REJECTED')).not.toBeInTheDocument();
  });

  it('E9 mover por "Mover a…" e por soltar (onDrop do shell) dá o mesmo estado final', async () => {
    await mount('09');
    await user.click(within(q('enquadre-participant-p-01')).getByTestId('move-to-button'));
    await user.click(screen.getByTestId('move-to-option-SELECTED'));
    await waitFor(() => expect(count('SELECTED')).toBe(1));
    const viaMenu = { counts: columnCounts(), column: q('enquadre-participant-p-01').getAttribute('data-column') };
    cleanup();
    restore?.();

    await mount('09');
    const item = { id: 'p-01' } as EnquadreParticipant;
    await act(async () => { capturedOnDrop!({ item, itemId: 'p-01', fromColumnId: 'CONVOKED', toColumnId: 'SELECTED' }); });
    await waitFor(() => expect(count('SELECTED')).toBe(1));
    const viaDrop = { counts: columnCounts(), column: q('enquadre-participant-p-01').getAttribute('data-column') };
    expect(viaDrop).toEqual(viaMenu);
    expect(viaDrop).toEqual({ counts: { CONVOKED: 4, SELECTED: 1, QUICK_RESPONSE_TEAM: 0, REJECTED: 0 }, column: 'SELECTED' });
  });

  it('E9 Rechazar pede o motivo; sair de Rechazados também (422 do servidor); soltar em Rechazados pergunta antes de mover', async () => {
    await mount('09');
    await user.click(within(q('enquadre-participant-p-02')).getByTestId('reject-button'));
    await user.click(q('rejection-option-distance'));
    await user.click(q('rejection-confirm'));
    await waitFor(() => expect(count('REJECTED')).toBe(1));
    expect(within(q('enquadre-participant-p-02')).getByTestId('rejection-badge')).toBeInTheDocument();
    await user.click(within(q('enquadre-participant-p-02')).getByTestId('move-to-button'));
    await user.click(screen.getByTestId('move-to-option-CONVOKED'));
    await user.click(await screen.findByTestId('move-reason-option-reavaliacao'));
    await user.click(q('move-reason-confirm'));
    await waitFor(() => expect(count('REJECTED')).toBe(0));
    expect(count('CONVOKED')).toBe(5);
    await act(async () => { capturedOnDrop!({ item: { id: 'p-03' } as EnquadreParticipant, itemId: 'p-03', fromColumnId: 'CONVOKED', toColumnId: 'REJECTED' }); });
    expect(await screen.findByTestId('rejection-modal')).toBeInTheDocument();
    expect(count('REJECTED')).toBe(0);
  });

  it('E10 encerrado: tudo sem arrasto, sem menu, sem Rechazar, sem botões; 1 devolvido visível em Convocados', async () => {
    await mount('10');
    expect(columnCounts()).toEqual({ CONVOKED: 1, SELECTED: 2, QUICK_RESPONSE_TEAM: 1, REJECTED: 1 });
    expect(document.querySelectorAll('[data-drag-disabled="true"]')).toHaveLength(5);
    expect(screen.queryByTestId('move-to-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enquadre-kanban-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enquadre-kanban-manage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enquadre-kanban-cancel')).not.toBeInTheDocument();
    expect(q('enquadre-kanban-readonly')).toBeInTheDocument();
    expect(text('enquadre-participant-returned-p-45')).toBe('Devuelto');
    expect(within(q('kanban-column-CONVOKED')).getByTestId('enquadre-participant-returned-p-45')).toBeInTheDocument();
  });

  it('E11 confirmar encerrar: o corpo traz 3 sem marcação; confirmar fecha o evento e devolve os 3', async () => {
    await mount('11');
    expect(text('enquadre-close-dialog')).toContain('3 convocados sin marcación vuelven a Completado');
    await user.click(q('enquadre-close-dialog-confirm'));
    await waitFor(() => expect(q('enquadre-kanban-header').getAttribute('data-phase')).toBe('closed'));
    expect(screen.queryByTestId('enquadre-kanban-actions')).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^enquadre-participant-returned-/)).toHaveLength(3);
  });
});

describe('Cancelar e gerir convocados (E14, E16, E17)', () => {
  it('E14 confirmar cancelar: o corpo traz os 5 convocados que ficam livres', async () => {
    await mount('14');
    expect(text('enquadre-cancel-dialog')).toContain('Se cancelará el evento en Google y los 5 convocados quedarán libres');
  });

  it('E16 acrescentar: 2 marcados habilitam "Agregar (2)"; ao confirmar, 5 → 7 e disponíveis 3 → 1; sem e-mail não seleciona', async () => {
    await mount('16');
    expect((q('enquadre-convoked-worker-checkbox-w-13') as HTMLInputElement).disabled).toBe(true);
    expect(text('enquadre-convoked-worker-reason-w-13')).toBe('Sin e-mail válido: no se puede convocar');
    const add = q('enquadre-convoked-add') as HTMLButtonElement;
    expect(add.getAttribute('data-count')).toBe('2');
    expect(add.disabled).toBe(false);
    expect(add.textContent).toBe('Agregar (2)');
    expect(q('enquadre-convoked-current').getAttribute('data-count')).toBe('5');
    expect(q('enquadre-convoked-available').getAttribute('data-count')).toBe('3');
    await user.click(add);
    await waitFor(() => expect(q('enquadre-convoked-current').getAttribute('data-count')).toBe('7'));
    expect(q('enquadre-convoked-available').getAttribute('data-count')).toBe('1');
    await waitFor(() => expect(count('CONVOKED')).toBe(7));
  });

  it('E17 quitar: o diálogo diz o que acontece; confirmar tira o convocado (5 → 4) e ele volta aos disponíveis', async () => {
    await mount('17');
    expect(text('enquadre-convoked-remove-dialog')).toContain('Saldrá del evento y de la invitación de Google y volverá a Completado');
    await user.click(q('enquadre-convoked-remove-dialog-confirm'));
    await waitFor(() => expect(q('enquadre-convoked-current').getAttribute('data-count')).toBe('4'));
    expect(q('enquadre-convoked-available').getAttribute('data-count')).toBe('4');
    expect(screen.queryByTestId('enquadre-convoked-item-p-03')).not.toBeInTheDocument();
  });

  it('E16→E17 acrescentar 2 e quitar 1: 5 → 7 → 6, disponíveis 3 → 1 → 2', async () => {
    await mount('16');
    await user.click(q('enquadre-convoked-add'));
    await waitFor(() => expect(q('enquadre-convoked-current').getAttribute('data-count')).toBe('7'));
    await user.click(q('enquadre-convoked-remove-p-03'));
    await user.click(await screen.findByTestId('enquadre-convoked-remove-dialog-confirm'));
    await waitFor(() => expect(q('enquadre-convoked-current').getAttribute('data-count')).toBe('6'));
    expect(q('enquadre-convoked-available').getAttribute('data-count')).toBe('2');
  });
});

describe('Kanban da vacante (E13)', () => {
  it('E13 sem Confirmado: 8 colunas, 3 em Completado (2 com etiqueta Convocado) e 1 em Selecionados', async () => {
    await mount('13');
    expect(columnIds()).toHaveLength(8);
    expect(screen.queryByTestId('kanban-column-CONFIRMED')).not.toBeInTheDocument();
    expect(count('COMPLETED')).toBe(3);
    expect(count('SELECTED')).toBe(1);
    const badges = screen.getAllByTestId('convocation-badge');
    expect(badges).toHaveLength(2);
    badges.forEach((b) => expect(b.textContent).toBe('Convocado · 16/10 14:00'));
  });

  it('E13 sem a prop `columns` o board continua com as 9 colunas de hoje', async () => {
    restore = installDataset('13');
    render(<MemoryRouter><KanbanBoard stages={funnelStages()} vacancyId="vac-01" onMove={async () => null} /></MemoryRouter>);
    expect(columnIds()).toHaveLength(9);
    expect(screen.getByTestId('kanban-column-CONFIRMED')).toBeInTheDocument();
  });
});
