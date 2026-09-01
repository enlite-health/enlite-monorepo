/**
 * A tela do catálogo (spec 010, F1).
 *
 * O que estes testes protegem:
 *  1. O TEXTO é a identidade da linha — `name` é igual ao `slug` nas 27 linhas
 *     de produção, então slug sozinho não diz nada a ninguém.
 *  2. Estado da Meta e elegibilidade aparecem SEPARADOS: APPROVED + inelegível
 *     é caso real e juntá-los esconderia o problema.
 *  3. Estado desconhecido aparece CRU — nunca vira "desconhecido" nem some.
 *  4. Nunca verificado ≠ pendente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TemplateCatalogPage } from '../TemplateCatalogPage';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';

const getTemplateCatalog = vi.fn();
vi.mock('@infrastructure/http/AdminTemplateCatalogApiService', () => ({
  AdminTemplateCatalogApiService: { getTemplateCatalog: (...a: unknown[]) => getTemplateCatalog(...a) },
}));
/**
 * Mock de `t` que imita o i18next de verdade em DOIS modos, e o segundo já me
 * mordeu: `t(chave, { count })` passa um OBJETO como segundo argumento. Um mock
 * ingênuo (`f ?? k`) devolvia esse objeto, React não renderiza objeto, e a tela
 * inteira saía em branco — 20 testes falhando por causa do dublê, não do código.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, arg?: string | Record<string, unknown>) =>
      typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? `${k}:${JSON.stringify(arg)}` : k,
  }),
}));

const row = (over: Partial<TemplateCatalogRow> = {}): TemplateCatalogRow => ({
  slug: 'ar_bienvenida', name: 'ar_bienvenida', bodyTwilio: 'Hola María, bienvenida',
  category: 'UTILITY', isActive: true, contentSid: 'HXaaa',
  metaStatus: 'APPROVED', metaReason: null, metaDetail: null,
  metaCheckedAt: '2026-08-31T12:00:00Z',
  eligible: true, ineligibleReason: null, placeholders: [], usedInStages: [], ...over,
});

const renderWith = async (templates: TemplateCatalogRow[]) => {
  getTemplateCatalog.mockResolvedValue({ templates });
  render(<TemplateCatalogPage />);
  await waitFor(() => expect(getTemplateCatalog).toHaveBeenCalled());
};

describe('TemplateCatalogPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mostra o TEXTO da mensagem, não só o slug', async () => {
    await renderWith([row()]);
    expect(await screen.findByText(/Hola María, bienvenida/)).toBeInTheDocument();
  });

  it('sem texto aprovado, diz que não tem — não inventa', async () => {
    await renderWith([row({ bodyTwilio: null })]);
    expect(await screen.findByTestId('tc-row-ar_bienvenida')).toBeInTheDocument();
    expect(screen.queryByText(/«/)).not.toBeInTheDocument();
  });

  it('mostra o estado da Meta', async () => {
    await renderWith([row()]);
    expect(await screen.findByTestId('tc-status-ar_bienvenida')).toHaveTextContent('APPROVED');
  });

  it('PAUSED aparece — é o estado que sumia da base', async () => {
    await renderWith([row({ metaStatus: 'PAUSED' })]);
    expect(await screen.findByTestId('tc-status-ar_bienvenida')).toHaveTextContent('PAUSED');
  });

  it('estado que não conhecemos aparece CRU, não vira "desconhecido"', async () => {
    await renderWith([row({ metaStatus: 'ALGO_NOVO' })]);
    expect(await screen.findByTestId('tc-status-ar_bienvenida')).toHaveTextContent('ALGO_NOVO');
  });

  it('nunca verificado NÃO vira "pendente"', async () => {
    await renderWith([row({ metaStatus: null, metaCheckedAt: null })]);
    const el = await screen.findByTestId('tc-status-ar_bienvenida');
    expect(el).not.toHaveTextContent('PENDING');
    expect(el).toHaveTextContent(/neverChecked/);
  });

  it('APROVADO e INELEGÍVEL convivem, em campos separados', async () => {
    await renderWith([row({ metaStatus: 'APPROVED', eligible: false, ineligibleReason: 'PLACEHOLDERS' })]);
    expect(await screen.findByTestId('tc-status-ar_bienvenida')).toHaveTextContent('APPROVED');
    expect(screen.getByTestId('tc-ineligible-ar_bienvenida')).toBeInTheDocument();
  });

  it('elegível não mostra aviso de inelegibilidade', async () => {
    await renderWith([row()]);
    await screen.findByTestId('tc-row-ar_bienvenida');
    expect(screen.queryByTestId('tc-ineligible-ar_bienvenida')).not.toBeInTheDocument();
  });

  it('mostra o motivo da recusa quando existe', async () => {
    await renderWith([row({ metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT' })]);
    expect(await screen.findByTestId('tc-reason-ar_bienvenida')).toHaveTextContent('INVALID_FORMAT');
  });

  it('🔒 "usado em" aparece — é o que protege quem for tirar a mensagem do ar', async () => {
    await renderWith([row({ usedInStages: ['SELECTED'] })]);
    expect(await screen.findByTestId('tc-used-ar_bienvenida')).toBeInTheDocument();
  });

  it('sem uso, diz que não está em uso', async () => {
    await renderWith([row()]);
    await screen.findByTestId('tc-row-ar_bienvenida');
    expect(screen.queryByTestId('tc-used-ar_bienvenida')).not.toBeInTheDocument();
  });

  it('catálogo vazio mostra estado vazio, não tabela', async () => {
    await renderWith([]);
    expect(await screen.findByTestId('tc-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('tc-table')).not.toBeInTheDocument();
  });

  it('falha de carga mostra o erro e não a tabela', async () => {
    getTemplateCatalog.mockRejectedValue(new Error('backend fora'));
    render(<TemplateCatalogPage />);
    const box = await screen.findByTestId('tc-load-error');
    // O texto que a pessoa lê vem traduzido; o detalhe técnico fica junto.
    expect(box).toHaveTextContent(/error/);
    expect(box).toHaveTextContent('backend fora');
    expect(screen.queryByTestId('tc-table')).not.toBeInTheDocument();
  });

  it('erro cuja mensagem é VAZIA ainda aparece — não vira sucesso silencioso', async () => {
    getTemplateCatalog.mockRejectedValue(new Error(''));
    render(<TemplateCatalogPage />);
    const box = await screen.findByTestId('tc-load-error');
    expect(box).toHaveTextContent(/error/);
    expect(screen.queryByTestId('tc-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tc-empty')).not.toBeInTheDocument();
  });

  it('erro que não é Error também aparece', async () => {
    getTemplateCatalog.mockRejectedValue('string crua');
    render(<TemplateCatalogPage />);
    expect(await screen.findByTestId('tc-load-error')).toBeInTheDocument();
  });

  describe('a cor separa "pendente" de "a Meta desligou"', () => {
    it.each([
      ['APPROVED', 'turquoise'],
      ['PENDING', 'wait'],
      ['IN_APPEAL', 'wait'],
      ['REJECTED', 'pink-cancel'],
      ['PAUSED', 'coordination'],
      ['DISABLED', 'coordination'],
      ['LIMIT_EXCEEDED', 'coordination'],
    ])('%s usa a paleta %s', async (status, paleta) => {
      await renderWith([row({ metaStatus: status })]);
      expect((await screen.findByTestId('tc-status-ar_bienvenida')).className).toContain(paleta);
    });

    it('estado desconhecido cai no neutro, sem fingir que sabe', async () => {
      await renderWith([row({ metaStatus: 'ALGO_NOVO' })]);
      expect((await screen.findByTestId('tc-status-ar_bienvenida')).className).toContain('bg-gray-300');
    });

    it('PAUSED e PENDING NÃO compartilham a cor — um é incidente, o outro é espera', async () => {
      await renderWith([row({ slug: 'a', metaStatus: 'PAUSED' }), row({ slug: 'b', metaStatus: 'PENDING' })]);
      const pausado = (await screen.findByTestId('tc-status-a')).className;
      const pendente = (await screen.findByTestId('tc-status-b')).className;
      expect(pausado).not.toBe(pendente);
    });
  });

  describe('faixa de filtros', () => {
    const tres = [
      row({ slug: 'a', metaStatus: 'APPROVED' }),
      row({ slug: 'b', metaStatus: 'PAUSED' }),
      row({ slug: 'c', metaStatus: null }),
    ];

    it('mostra a contagem por estado', async () => {
      await renderWith(tres);
      expect(await screen.findByTestId('tc-filter-all')).toHaveTextContent('3');
      expect(screen.getByTestId('tc-filter-off')).toHaveTextContent('1');
      expect(screen.getByTestId('tc-filter-rejected')).toHaveTextContent('0');
    });

    it('filtro com zero NÃO some — "nenhuma rejeitada" é informação', async () => {
      await renderWith(tres);
      expect(await screen.findByTestId('tc-filter-rejected')).toBeInTheDocument();
    });

    it('clicar filtra a lista', async () => {
      await renderWith(tres);
      await userEvent.click(await screen.findByTestId('tc-filter-off'));
      expect(screen.getByTestId('tc-row-b')).toBeInTheDocument();
      expect(screen.queryByTestId('tc-row-a')).not.toBeInTheDocument();
    });

    it('marca o filtro ativo para leitor de tela', async () => {
      await renderWith(tres);
      await userEvent.click(await screen.findByTestId('tc-filter-off'));
      expect(screen.getByTestId('tc-filter-off')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('tc-filter-all')).toHaveAttribute('aria-pressed', 'false');
    });

    it('filtro sem ninguém mostra vazio de FILTRO, não o vazio de catálogo', async () => {
      await renderWith(tres);
      await userEvent.click(await screen.findByTestId('tc-filter-rejected'));
      expect(screen.getByTestId('tc-filter-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('tc-empty')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tc-table')).not.toBeInTheDocument();
    });

    it('catálogo vazio não mostra faixa de filtros', async () => {
      await renderWith([]);
      await screen.findByTestId('tc-empty');
      expect(screen.queryByTestId('tc-filters')).not.toBeInTheDocument();
    });
  });

  describe('idade da sincronização', () => {
    it('aparece quando alguém já foi verificado', async () => {
      await renderWith([row({ metaCheckedAt: new Date().toISOString() })]);
      expect(await screen.findByTestId('tc-sync-age')).toBeInTheDocument();
    });

    it('não aparece quando ninguém foi verificado — não inventa idade', async () => {
      await renderWith([row({ metaCheckedAt: null })]);
      await screen.findByTestId('tc-table');
      expect(screen.queryByTestId('tc-sync-age')).not.toBeInTheDocument();
    });
  });

  describe('variáveis da mensagem', () => {
    it('mostra quais dados a mensagem exige', async () => {
      await renderWith([row({ placeholders: ['worker_name', 'case_number'] })]);
      const chips = await screen.findByTestId('tc-vars-ar_bienvenida');
      expect(chips).toHaveTextContent('worker_name');
      expect(chips).toHaveTextContent('case_number');
    });

    it('sem variáveis não mostra bloco vazio', async () => {
      await renderWith([row({ placeholders: [] })]);
      await screen.findByTestId('tc-row-ar_bienvenida');
      expect(screen.queryByTestId('tc-vars-ar_bienvenida')).not.toBeInTheDocument();
    });
  });

  it('data de verificação é formatada', async () => {
    await renderWith([row()]);
    expect(await screen.findByText(/31\/08\/2026/)).toBeInTheDocument();
  });
});
