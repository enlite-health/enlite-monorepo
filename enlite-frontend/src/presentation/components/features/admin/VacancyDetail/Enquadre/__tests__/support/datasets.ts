/**
 * datasets — os 17 estados do protótipo (spec 052, tabela "Estados a prototipar" do plano). Cada estado diz QUE tela
 * é a raiz (`root`), com que dados o "servidor" nasce (`seed`) e o nome do print. O que o estado tem "aberto" (drawer,
 * diálogo, painel) é feito por `autoSteps.ts`, com cliques reais na tela — nenhuma prop de produção existe para isso.
 */
import { HARNESS_VACANCY_ID, AVAILABLE_BASE, DRAWER_WORKERS, DRAWER_WORKERS_WITH_BLOCKED, EV_01, EV_02, EV_03, EV_03_E11, EV_04, EV_05, EV_PIPELINE } from './fixtures';
import { AdminPresentationInviteApiService } from '@infrastructure/http/AdminPresentationInviteApiService';
import { installFakeServer, type Seed } from './store';

/** 'tabs' = barra de abas real + aba Enquadre; 'tab' = só a aba; 'funnel' = o quadro da vacante. */
export type PreviewRoot = 'tabs' | 'tab' | 'funnel';

export interface PreviewDataset {
  id: string;
  /** Nome do print (sem extensão). */
  slug: string;
  title: string;
  root: PreviewRoot;
  seed: Seed;
}

const LIST_UPCOMING: Seed = { events: [EV_01, EV_02], available: AVAILABLE_BASE };
const DRAWER_SEED: Seed = { events: [EV_01, EV_02], available: DRAWER_WORKERS };

export const DATASETS: readonly PreviewDataset[] = [
  { id: '01', slug: '01-abas-recrutamento-enquadre', title: 'Abas do detalhe da vaga: Recrutamento e Enquadre', root: 'tabs', seed: LIST_UPCOMING },
  { id: '02', slug: '02-lista-vazia', title: 'Lista vazia', root: 'tab', seed: { events: [], available: AVAILABLE_BASE } },
  { id: '03', slug: '03-lista-proximos', title: 'Lista com próximos eventos', root: 'tab', seed: LIST_UPCOMING },
  { id: '04', slug: '04-lista-pendente-de-encerrar', title: 'Lista com evento pendente de encerrar', root: 'tab', seed: { events: [EV_01, EV_02, EV_03], available: AVAILABLE_BASE } },
  { id: '05', slug: '05-lista-encerrados', title: 'Lista com eventos encerrados', root: 'tab', seed: { events: [EV_01, EV_02, EV_03, EV_04, EV_05], available: AVAILABLE_BASE } },
  { id: '06', slug: '06-drawer-criar', title: 'Drawer Criar evento', root: 'tab', seed: DRAWER_SEED },
  { id: '07', slug: '07-drawer-erro-google', title: 'Drawer com erro do Google', root: 'tab', seed: { ...DRAWER_SEED, createFails: true } },
  { id: '08', slug: '08-drawer-prestador-sem-email', title: 'Drawer com prestador sem e-mail', root: 'tab', seed: { events: [EV_01, EV_02], available: DRAWER_WORKERS_WITH_BLOCKED } },
  { id: '09', slug: '09-kanban-evento-aberto', title: 'Kanban do evento aberto', root: 'tab', seed: LIST_UPCOMING },
  { id: '10', slug: '10-kanban-evento-encerrado', title: 'Kanban do evento encerrado', root: 'tab', seed: { events: [EV_04], available: AVAILABLE_BASE } },
  { id: '11', slug: '11-confirmar-encerrar', title: 'Confirmação de encerrar evento', root: 'tab', seed: { events: [EV_03_E11], available: AVAILABLE_BASE } },
  { id: '12', slug: '12-linha-selos-esteira', title: 'Linhas com os selos da esteira pós-call', root: 'tab', seed: { events: EV_PIPELINE, available: AVAILABLE_BASE } },
  { id: '13', slug: '13-kanban-vacante-sem-confirmado', title: 'Kanban da vacante sem Confirmado e com etiqueta Convocado', root: 'funnel', seed: { events: [], available: [] } },
  { id: '14', slug: '14-confirmar-cancelar', title: 'Confirmação de cancelar evento', root: 'tab', seed: LIST_UPCOMING },
  { id: '15', slug: '15-lista-apos-cancelar', title: 'Lista depois do cancelamento', root: 'tab', seed: LIST_UPCOMING },
  { id: '16', slug: '16-convocados-acrescentar', title: 'Acrescentar convocado', root: 'tab', seed: LIST_UPCOMING },
  { id: '17', slug: '17-convocados-quitar', title: 'Tirar convocado', root: 'tab', seed: LIST_UPCOMING },
];

export function datasetById(id: string): PreviewDataset | undefined {
  return DATASETS.find((d) => d.id === id);
}

/** O quadro da vacante (E13) não fala com o servidor do enquadre; só o "último convite" do card precisa de resposta. */
function stubFunnelServices(): void {
  (AdminPresentationInviteApiService as unknown as { last: () => Promise<Record<string, never>> }).last = async () => ({});
}

/** Instala o servidor falso do estado sobre `AdminEnquadreApiService`. Devolve o desfazer. */
export function installDataset(id: string): () => void {
  const ds = datasetById(id);
  if (!ds) throw new Error(`estado desconhecido: ${id}`);
  stubFunnelServices();
  // E13: o quadro da vacante tem 8 colunas de 280px e rola na horizontal (é assim hoje). O print recolhe as colunas
  // vazias pelo recurso REAL de colapso (persistido por vaga) para que Completado e Selecionados caibam em 1440px.
  if (ds.root === 'funnel') {
    try {
      localStorage.setItem(`kanban-collapsed-${HARNESS_VACANCY_ID}`, JSON.stringify(['COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'REJECTED']));
    } catch {
      // sem localStorage o quadro só fica expandido
    }
  }
  return installFakeServer(ds.seed);
}
