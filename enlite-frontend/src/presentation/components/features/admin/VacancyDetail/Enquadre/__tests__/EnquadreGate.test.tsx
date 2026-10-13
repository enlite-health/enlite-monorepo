/**
 * Gate por célula da aba Enquadre (spec 052, T-31): com o enforcement LIGADO, cada botão de ação existe só para quem
 * tem a célula da rota que ele chama (`enquadre_event:*`, `enquadre_result:update`); o arrasto, "Mover a…" e
 * "Rechazar" do kanban do evento seguem `enquadre_result:update`. Com o enforcement desligado nada some.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@infrastructure/i18n/config';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { CreateEnquadreEventDrawer } from '../CreateEnquadreEventDrawer';
import { datasetById, installDataset } from './support/datasets';
import { StateRoot } from './support/PreviewShell';

let dragDisabled: ((item: unknown) => boolean) | null = null;
vi.mock('@presentation/components/features/admin/Kanban/KanbanBoardShell', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@presentation/components/features/admin/Kanban/KanbanBoardShell')>();
  const Real = mod.KanbanBoardShell;
  const { createElement } = await import('react');
  return {
    ...mod,
    KanbanBoardShell: (props: { isDragDisabled: (item: unknown) => boolean } & Record<string, unknown>) => {
      dragDisabled = props.isDragDisabled;
      return createElement(Real as never, props as never);
    },
  };
});

const before = useAdminAuthStore.getState();
let restore: (() => void) | null = null;

function setAuthz(enforcement: 'on' | 'off', permissions: string[]): void {
  useAdminAuthStore.setState({ authz: { enforcement, permissions } as never, authzStatus: 'ready' });
}

async function mountList(): Promise<void> {
  restore = installDataset('03');
  render(<MemoryRouter><StateRoot dataset={datasetById('03')!} /></MemoryRouter>);
  await screen.findByTestId('enquadre-events-table');
}

async function openOpenEvent(): Promise<void> {
  await userEvent.click(screen.getByTestId('enquadre-event-row-ev-01'));
  await screen.findByTestId('enquadre-kanban-board');
  await waitFor(() => expect(screen.queryByTestId('enquadre-kanban-loading')).not.toBeInTheDocument());
}

const has = (id: string): boolean => screen.queryByTestId(id) !== null;
const EVENT_ALL = ['enquadre_event:read', 'enquadre_event:create', 'enquadre_event:update'];

beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => { cleanup(); restore?.(); restore = null; dragDisabled = null; useAdminAuthStore.setState({ authz: before.authz, authzStatus: before.authzStatus }); });

describe('botões de ação × célula (enforcement ligado)', () => {
  it('só com enquadre_event:read: "Crear evento" some da lista', async () => {
    setAuthz('on', ['enquadre_event:read']);
    await mountList();
    expect(has('enquadre-create-button')).toBe(false);
  });

  it('com enquadre_event:create: "Crear evento" existe e abre o drawer com "Crear"', async () => {
    setAuthz('on', ['enquadre_event:read', 'enquadre_event:create']);
    await mountList();
    await userEvent.click(screen.getByTestId('enquadre-create-button'));
    await screen.findByTestId('enquadre-create-drawer');
    expect(has('enquadre-create-submit')).toBe(true);
  });

  it('o "Crear" do drawer: some sem enquadre_event:create, existe com ela', async () => {
    const drawer = (): JSX.Element => (
      <CreateEnquadreEventDrawer vacancyId="v-1" workers={[]} workersStatus="ok" onCreated={() => undefined} onClose={() => undefined} />
    );
    restore = installDataset('03');
    setAuthz('on', ['enquadre_event:read']);
    const { unmount } = render(<MemoryRouter>{drawer()}</MemoryRouter>);
    await screen.findByTestId('enquadre-create-drawer');
    expect(has('enquadre-create-cancel')).toBe(true);
    expect(has('enquadre-create-submit')).toBe(false);
    unmount();
    setAuthz('on', ['enquadre_event:read', 'enquadre_event:create']);
    render(<MemoryRouter>{drawer()}</MemoryRouter>);
    await screen.findByTestId('enquadre-create-drawer');
    expect(has('enquadre-create-submit')).toBe(true);
  });

  it('só com enquadre_event:read: o kanban não oferece gestionar, cancelar nem encerrar, nem arrasto, mover ou rechazar', async () => {
    setAuthz('on', ['enquadre_event:read']);
    await mountList();
    await openOpenEvent();
    for (const id of ['enquadre-kanban-manage', 'enquadre-kanban-cancel', 'enquadre-kanban-close', 'move-to-button', 'reject-button']) {
      expect(has(id), id).toBe(false);
    }
    expect(dragDisabled!({ id: 'p-01' })).toBe(true);
  });

  it('enquadre_event:update oferece gestionar e cancelar, mas não encerrar nem mover', async () => {
    setAuthz('on', ['enquadre_event:read', 'enquadre_event:update']);
    await mountList();
    await openOpenEvent();
    expect(has('enquadre-kanban-manage')).toBe(true);
    expect(has('enquadre-kanban-cancel')).toBe(true);
    expect(has('enquadre-kanban-close')).toBe(false);
    expect(has('move-to-button')).toBe(false);
    expect(dragDisabled!({ id: 'p-01' })).toBe(true);
  });

  it('enquadre_result:update oferece encerrar, arrasto, mover e rechazar, mas não gestionar nem cancelar', async () => {
    setAuthz('on', ['enquadre_event:read', 'enquadre_result:update']);
    await mountList();
    await openOpenEvent();
    expect(has('enquadre-kanban-close')).toBe(true);
    expect(screen.getAllByTestId('move-to-button')).toHaveLength(5);
    expect(screen.getAllByTestId('reject-button')).toHaveLength(5);
    expect(dragDisabled!({ id: 'p-01' })).toBe(false);
    expect(has('enquadre-kanban-manage')).toBe(false);
    expect(has('enquadre-kanban-cancel')).toBe(false);
  });

  it('o motivo de "Encerrar" bloqueado só aparece quando o botão aparece: sem enquadre_result:update some o texto; com ela ficam os dois', async () => {
    setAuthz('on', ['enquadre_event:read', 'enquadre_event:update']);
    await mountList();
    await openOpenEvent();
    expect(has('enquadre-kanban-close')).toBe(false);
    expect(has('enquadre-kanban-close-blocked')).toBe(false);
    cleanup(); restore?.(); restore = null;
    setAuthz('on', ['enquadre_event:read', 'enquadre_result:update']);
    await mountList();
    await openOpenEvent();
    expect(has('enquadre-kanban-close')).toBe(true);
    expect(has('enquadre-kanban-close-blocked')).toBe(true);
  });

  it('no painel de convocados, "Quitar" e "Agregar" existem com enquadre_event:update', async () => {
    setAuthz('on', [...EVENT_ALL]);
    await mountList();
    await openOpenEvent();
    await userEvent.click(screen.getByTestId('enquadre-kanban-manage'));
    await screen.findByTestId('enquadre-convoked-panel');
    expect(has('enquadre-convoked-add')).toBe(true);
    expect(screen.getAllByTestId(/^enquadre-convoked-remove-p-/).length).toBeGreaterThan(0);
    expect(has('enquadre-convoked-close')).toBe(true);
  });
});

describe('enforcement desligado', () => {
  it('nada some, mesmo sem nenhuma célula', async () => {
    setAuthz('off', []);
    await mountList();
    expect(has('enquadre-create-button')).toBe(true);
    await openOpenEvent();
    for (const id of ['enquadre-kanban-manage', 'enquadre-kanban-cancel', 'enquadre-kanban-close']) expect(has(id), id).toBe(true);
    expect(dragDisabled!({ id: 'p-01' })).toBe(false);
  });
});
