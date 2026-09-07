/**
 * FunnelStageMessagesPage — o que o teste existente NÃO consegue ver.
 *
 * `FunnelStageMessagesPage.test.tsx` mocka o `t` para devolver a própria chave.
 * Isso é ótimo para afirmar lógica (qual template, quem salvou, quem só lê) e
 * **cego por construção** para tradução faltando: com o mock, `t('a.b.C')` vira
 * `'a.b.C'` e passa. Foi assim que 3 das 6 etapas ficaram meses mostrando enum
 * cru do banco — `INTERVIEWED`, `PRESENTED`, `HIRED` — num painel em espanhol,
 * com o `stageLabel` caindo no fallback sem fazer barulho.
 *
 * Este arquivo usa os arquivos de tradução REAIS (mesmo padrão de
 * AdmisionPage.emptySlots.test.tsx) e prende as duas coisas que a revisão visual
 * de 30/08 achou e que nenhum teste via:
 *
 *   1. nenhuma etapa vaza enum cru na tela
 *   2. o <thead> tem UM <tr> — o TableHeader já emite o dele, e envolver os
 *      <TableHead> em outro <TableRow> gerava <tr> dentro de <tr>. O parser
 *      desfazia o aninhamento e o cabeçalho saía do cálculo de colunas: os
 *      títulos ocupavam 349px sobre linhas de 1096px, nenhum alinhado à sua
 *      coluna. É invisível para o tsc e para todo teste que só busca por texto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { FunnelStageMessagesPage } from '../FunnelStageMessagesPage';

const mockGet = vi.fn();
vi.mock('@infrastructure/http/AdminFunnelStageMessagesApiService', () => ({
  AdminFunnelStageMessagesApiService: {
    getFunnelStageMessages: (...a: unknown[]) => mockGet(...a),
    updateFunnelStageMessage: vi.fn(),
  },
}));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: {}, isAuthenticated: true, isLoading: false }),
}));

/** As 6 etapas da tela real, incluindo as 3 que vazavam. */
const STAGES = ['QUALIFIED', 'IN_DOUBT', 'INTERVIEWED', 'PRESENTED', 'HIRED', 'REJECTED'];

const config = () => ({
  country: 'AR',
  stages: STAGES.map((stage) => ({
    stage, templateSlug: null, enabled: false, channel: 'whatsapp',
    builtin: stage === 'QUALIFIED' ? 'interview_invite' : null,
    updatedBy: null, updatedAt: null,
  })),
  templates: [{ slug: 'ok_tpl', name: 'Ok', category: 'UTILITY', eligible: true, reason: null, placeholders: [], unsupported: [] }],
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(config());
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({ lng: 'es', fallbackLng: 'es', resources: {}, interpolation: { escapeValue: false } });
  }
  i18n.addResourceBundle('es', 'translation', es, true, true);
  i18n.addResourceBundle('pt-BR', 'translation', ptBR, true, true);
});

/**
 * ⚠️ Por que o teste de PARIDADE existe além do de render.
 *
 * O render sozinho é cego para chave faltando, e isso foi MEDIDO: apagando
 * `stages.INTERVIEWED` do es.json, a tela continuou mostrando "Entrevistados" e
 * os 5 testes passaram. O motivo é o `fallbackLng` — `src/test/setup.ts:12` usa
 * 'pt-BR' e `infrastructure/i18n/config.ts:38` usa 'es' — então a ausência num
 * idioma é servida pelo outro. Como INTERVIEWED e HIRED têm a MESMA palavra nos
 * dois, o fallback mascarou a deleção por completo.
 *
 * Os 3 enums crus só ficaram visíveis porque faltavam nos DOIS arquivos. Ou
 * seja: o modo de falha mais provável (falta em um) é justamente o que o render
 * não vê. Por isso a paridade é afirmada sobre o JSON, onde não há fallback.
 */
describe('as chaves existem nos DOIS idiomas — imune ao fallback', () => {
  const stagesOf = (loc: Record<string, any>) => loc.admin.funnelStageMessages.stages ?? {};

  it.each(STAGES)('%s tem rótulo próprio em es E em pt-BR', (stage) => {
    // QUALIFIED e REJECTED podem vir de admin.kanban.columns (nome do Kanban).
    const has = (loc: Record<string, any>) =>
      Boolean(stagesOf(loc)[stage] ?? loc.admin?.kanban?.columns?.[stage]);
    expect(has(es as Record<string, any>)).toBe(true);
    expect(has(ptBR as Record<string, any>)).toBe(true);
  });

  it('nenhum rótulo de etapa é o próprio enum', () => {
    for (const loc of [es, ptBR] as Record<string, any>[]) {
      for (const [stage, label] of Object.entries(stagesOf(loc))) {
        expect(label).not.toBe(stage);
      }
    }
  });
});

describe('nenhuma etapa vaza enum cru do banco', () => {
  it.each(['es', 'pt-BR'])('%s: as 6 etapas aparecem traduzidas', async (lng) => {
    await i18n.changeLanguage(lng);
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());

    for (const stage of STAGES) {
      const row = screen.getByTestId(`fsm-row-${stage}`);
      const label = row.querySelector('td')!.textContent!.trim();
      // O enum cru é MAIÚSCULA_COM_UNDERSCORE; um rótulo humano nunca é.
      expect(label).not.toMatch(/^[A-Z][A-Z_]+$/);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('es: as três que vazavam têm nome próprio', async () => {
    await i18n.changeLanguage('es');
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());

    expect(screen.getByTestId('fsm-row-INTERVIEWED')).toHaveTextContent('Entrevistados');
    expect(screen.getByTestId('fsm-row-PRESENTED')).toHaveTextContent('Presentados');
    expect(screen.getByTestId('fsm-row-HIRED')).toHaveTextContent('Contratados');
  });
});

describe('a tabela é uma tabela — cabeçalho no mesmo grid do corpo', () => {
  it('o <thead> tem exatamente UM <tr>', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());

    const thead = screen.getByTestId('fsm-table').querySelector('thead')!;
    // Dois <tr> aqui significa que alguém envolveu os <TableHead> num
    // <TableRow> de novo — o TableHeader já emite o próprio.
    expect(thead.querySelectorAll('tr')).toHaveLength(1);
  });

  it('há um <th> para cada coluna do corpo', async () => {
    render(<FunnelStageMessagesPage />);
    await waitFor(() => expect(screen.getByTestId('fsm-table')).toBeInTheDocument());

    const table = screen.getByTestId('fsm-table');
    const ths = table.querySelectorAll('thead th').length;
    const tds = table.querySelector('tbody tr')!.querySelectorAll('td').length;
    expect(ths).toBe(tds);
  });
});
