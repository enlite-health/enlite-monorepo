/**
 * TherapeuticCatalogCidPanel (spec 091 T307): contagem, busca local, adicionar (objetivo: busca; atividade:
 * só categorias do objetivo), remover com aviso quando activityLinks>0, só leitura sem `:update`.
 * Usa um FAKE da porta TherapeuticCatalogGateway (não mock de fetch); i18n resolvido contra o pt-BR real.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { TherapeuticCatalogGateway } from '@domain/repositories/TherapeuticCatalogGateway';
import type { CategoryLink, IcdCategory } from '@domain/entities/TherapeuticProject';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const part of key.split('.')) cur = cur?.[part];
  if (typeof cur !== 'string') return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
  return cur.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(opts?.[k] ?? ''));
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const { TherapeuticCatalogCidPanel } = await import('../TherapeuticCatalogCidPanel');

function fakeGateway(init: { objective?: CategoryLink[]; activity?: CategoryLink[]; objectiveOfActivity?: CategoryLink[]; search?: IcdCategory[] }) {
  const state = { objective: [...(init.objective ?? [])], activity: [...(init.activity ?? [])] };
  const calls = { removeObjective: vi.fn(), addObjective: vi.fn(), addActivity: vi.fn(), search: vi.fn() };
  const list = (items: CategoryLink[]) => Promise.resolve({ total: items.length, items: [...items] });
  const gw = {
    listObjectiveCategories: vi.fn(() => list(init.objectiveOfActivity ?? state.objective)),
    listActivityCategories: vi.fn(() => list(state.activity)),
    searchIcdCategories: vi.fn(async (q: string) => { calls.search(q); return init.search ?? []; }),
    addObjectiveCategory: vi.fn(async (_id: string, code: string) => {
      calls.addObjective(code); state.objective.push({ code, title: 'novo', activityLinks: 0 }); return { code, title: 'novo' };
    }),
    removeObjectiveCategory: vi.fn(async (_id: string, code: string) => {
      calls.removeObjective(code); state.objective = state.objective.filter((l) => l.code !== code); return { removedActivityLinks: 0 };
    }),
    addActivityCategory: vi.fn(async (_id: string, code: string) => {
      calls.addActivity(code); state.activity.push({ code, title: 'x' }); return { code, title: 'x' };
    }),
    removeActivityCategory: vi.fn(async () => ({ removed: true })),
  } as unknown as TherapeuticCatalogGateway;
  return { gw, calls };
}

const OBJ: CategoryLink[] = [
  { code: '6A02', title: 'Transtorno do espectro do autismo', activityLinks: 0 },
  { code: '6A05', title: 'Déficit de atenção', activityLinks: 3 },
  { code: '9Z99', title: null, activityLinks: 0 },
];

function renderPanel(gw: TherapeuticCatalogGateway, over: Record<string, unknown> = {}) {
  return render(<TherapeuticCatalogCidPanel kind="objective" itemId="o1" itemLabel="Objetivo X" isOpen onClose={() => {}} canWrite gateway={gw} {...over} />);
}

describe('TherapeuticCatalogCidPanel', () => {
  it('mostra a contagem e as linhas "código — título", com o texto de ausência do release', async () => {
    const { gw } = fakeGateway({ objective: OBJ });
    renderPanel(gw);
    await waitFor(() => expect(screen.getByTestId('cid-panel-count')).toHaveTextContent('3 categorias'));
    expect(screen.getByTestId('cid-panel-row-6A02')).toHaveTextContent('6A02 — Transtorno do espectro do autismo');
    expect(screen.getByTestId('cid-panel-row-9Z99')).toHaveTextContent(ptBR.admin.therapeuticCatalog.icdNotInRelease);
  });

  it('busca local filtra por código ou título', async () => {
    const { gw } = fakeGateway({ objective: OBJ });
    renderPanel(gw);
    await screen.findByTestId('cid-panel-row-6A02');
    fireEvent.change(screen.getByTestId('cid-panel-filter'), { target: { value: 'atenção' } });
    expect(screen.queryByTestId('cid-panel-row-6A02')).toBeNull();
    expect(screen.getByTestId('cid-panel-row-6A05')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('cid-panel-filter'), { target: { value: '6a02' } });
    expect(screen.getByTestId('cid-panel-row-6A02')).toBeInTheDocument();
    expect(screen.queryByTestId('cid-panel-row-6A05')).toBeNull();
  });

  it('objetivo: Agregar usa a busca de icd-categories e esconde os já ligados', async () => {
    const { gw, calls } = fakeGateway({ objective: OBJ, search: [{ code: '6A02', title: 'ja' }, { code: '6A06', title: 'Outra' }] });
    renderPanel(gw);
    await screen.findByTestId('cid-panel-row-6A02');
    fireEvent.change(screen.getByTestId('cid-panel-add-search'), { target: { value: '6A0' } });
    await screen.findByTestId('cid-panel-candidate-6A06');
    expect(calls.search).toHaveBeenCalledWith('6A0');
    expect(screen.queryByTestId('cid-panel-candidate-6A02')).toBeNull();
    fireEvent.click(screen.getByTestId('cid-panel-add-6A06'));
    await waitFor(() => expect(calls.addObjective).toHaveBeenCalledWith('6A06'));
    await waitFor(() => expect(screen.getByTestId('cid-panel-count')).toHaveTextContent('4 categorias'));
  });

  it('atividade: select só com categorias do objetivo ainda não ligadas; sem campo de busca', async () => {
    const { gw, calls } = fakeGateway({
      activity: [{ code: '6A02', title: 'a' }],
      objectiveOfActivity: [{ code: '6A02', title: 'a', activityLinks: 1 }, { code: '6A05', title: 'b', activityLinks: 0 }],
    });
    render(<TherapeuticCatalogCidPanel kind="activity" itemId="a1" objectiveId="o1" itemLabel="Atividade" isOpen onClose={() => {}} canWrite gateway={gw} />);
    const trigger = await screen.findByTestId('cid-panel-add-select');
    fireEvent.click(trigger);
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.getAttribute('data-value'))).toEqual(['6A05']);
    expect(screen.queryByTestId('cid-panel-add-search')).toBeNull();
    fireEvent.click(opts[0].querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(calls.addActivity).toHaveBeenCalledWith('6A05'));
  });

  it('remover com activityLinks>0 avisa a contagem e só remove ao confirmar', async () => {
    const { gw, calls } = fakeGateway({ objective: OBJ });
    renderPanel(gw);
    await screen.findByTestId('cid-panel-row-6A05');
    fireEvent.click(screen.getByTestId('cid-panel-remove-6A05'));
    expect(screen.getByTestId('cid-panel-confirm')).toHaveTextContent('Também serão removidos 3 vínculos de atividades');
    expect(calls.removeObjective).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cid-panel-confirm-no'));
    expect(screen.queryByTestId('cid-panel-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('cid-panel-remove-6A05'));
    fireEvent.click(screen.getByTestId('cid-panel-confirm-yes'));
    await waitFor(() => expect(calls.removeObjective).toHaveBeenCalledWith('6A05'));
    await waitFor(() => expect(screen.queryByTestId('cid-panel-row-6A05')).toBeNull());
  });

  it('remover com activityLinks=0 remove direto, sem aviso', async () => {
    const { gw, calls } = fakeGateway({ objective: OBJ });
    renderPanel(gw);
    await screen.findByTestId('cid-panel-row-6A02');
    fireEvent.click(screen.getByTestId('cid-panel-remove-6A02'));
    expect(screen.queryByTestId('cid-panel-confirm')).toBeNull();
    await waitFor(() => expect(calls.removeObjective).toHaveBeenCalledWith('6A02'));
  });

  it('sem :update (canWrite=false) é só leitura: sem Agregar nem Quitar', async () => {
    const { gw } = fakeGateway({ objective: OBJ });
    renderPanel(gw, { canWrite: false });
    await screen.findByTestId('cid-panel-row-6A02');
    expect(screen.queryByTestId('cid-panel-add')).toBeNull();
    expect(screen.queryByTestId('cid-panel-remove-6A02')).toBeNull();
  });
});
