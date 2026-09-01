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
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { dataLegivel } from '../templateCatalogView';

/**
 * ⚠️ As telas passaram a ter `<Link>` em 01/09 (o botão que liga o catálogo à
 * tela de criar). Sem Router o React quebra em `basename` — 79 testes caíram de
 * uma vez, e nenhum deles falava de navegação. Envolver aqui mantém os testes
 * medindo o que mediam.
 */
const render = (ui: React.ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
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
  language: 'es-AR',
  category: 'UTILITY', isActive: true, contentSid: 'HXaaa',
  metaStatus: 'APPROVED', metaReason: null, metaDetail: null,
  metaCheckedAt: '2026-08-31T12:00:00Z',
  eligible: true, ineligibleReason: null, placeholders: [], usedInStages: [],
  ...over,
  // 🔒 O `baseName` acompanha o slug por padrão — é o caso REAL de 12 das 28
  // linhas de produção, que não têm marcador de idioma nenhum e cujo
  // `base_name` é o próprio slug. Sem isto, dois fixtures com slugs
  // diferentes cairiam no mesmo `baseName` e colapsariam numa linha só,
  // fazendo o teste medir um agrupamento que produção não tem.
  baseName: over.baseName ?? over.slug ?? 'ar_bienvenida',
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

describe('variáveis da mensagem — saíram da LISTA e vieram para o DETALHE', () => {
    it('🔒 a listagem NÃO mostra mais as variáveis', async () => {
      // Nos 27 templates antigos, posicionais, isto virava "1 2 3 4 5" na
      // listagem: números nus que não ensinam nada. Decisão do Gabriel, 01/09.
      await renderWith([row({ placeholders: ['1', '2', '3', '4', '5'] })]);
      await screen.findByTestId('tc-table');
      expect(screen.queryByTestId('tc-vars-ar_bienvenida')).not.toBeInTheDocument();
    });

    it('clicar na linha abre o detalhe com as variáveis E a explicação', async () => {
      const u = userEvent.setup();
      await renderWith([row({ placeholders: ['1', '2'], eligible: false, ineligibleReason: 'PLACEHOLDERS' })]);
      await u.click(screen.getByTestId('tc-row-ar_bienvenida'));

      const det = await screen.findByTestId('tc-detalhe');
      expect(det).toBeTruthy();
      expect(screen.getByTestId('tc-detalhe-vars').textContent).toContain('{{1}}');
      // A frase que faltava: sem ela, "1 2" continua não dizendo nada.
      expect(screen.getByTestId('tc-detalhe-vars-posicionais').textContent)
        .toContain('variaveisPosicionais');
    });

    it('variável NOMEADA ganha a explicação certa, não a de posicional', async () => {
      const u = userEvent.setup();
      await renderWith([row({ placeholders: ['worker_name'] })]);
      await u.click(screen.getByTestId('tc-row-ar_bienvenida'));
      await screen.findByTestId('tc-detalhe');
      expect(screen.getByTestId('tc-detalhe-vars-nomeadas')).toBeTruthy();
      expect(screen.queryByTestId('tc-detalhe-vars-posicionais')).toBeNull();
    });

    it('sem variáveis o detalhe DIZ que é texto fixo, não deixa em branco', async () => {
      const u = userEvent.setup();
      await renderWith([row({ placeholders: [] })]);
      await u.click(screen.getByTestId('tc-row-ar_bienvenida'));
      await screen.findByTestId('tc-detalhe');
      expect(screen.getByTestId('tc-detalhe-vars-nenhuma').textContent).toContain('semVariaveis');
    });

    it('o detalhe fecha', async () => {
      const u = userEvent.setup();
      await renderWith([row({ placeholders: [] })]);
      await u.click(screen.getByTestId('tc-row-ar_bienvenida'));
      await screen.findByTestId('tc-detalhe');
      await u.click(screen.getByTestId('tc-detalhe-fechar'));
      await waitFor(() => expect(screen.queryByTestId('tc-detalhe')).toBeNull());
    });

    it('🔒 o botão de REGISTRAR mensagem existe na listagem', async () => {
      // Sem ele, quem abre "Plantillas" vê só uma lista e conclui que não dá
      // para adicionar mensagem — foi exatamente o que aconteceu.
      await renderWith([row({})]);
      await screen.findByTestId('tc-table');
      const botao = screen.getByTestId('tc-nova-mensagem');
      expect(botao.getAttribute('href')).toBe('/admin/plantillas/registrar');
    });
  });

  describe('variáveis — casos antigos', () => {
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

describe('o detalhe da mensagem — os campos que só ele mostra', () => {
  const abrir = async (over: Record<string, unknown>) => {
    const u = userEvent.setup();
    await renderWith([row(over)]);
    await u.click(screen.getByTestId('tc-row-ar_bienvenida'));
    await screen.findByTestId('tc-detalhe');
    return u;
  };

  it('mostra o TEXTO aprovado, que é o que a pessoa veio ver', async () => {
    await abrir({ bodyTwilio: 'Hola {{1}}, todo bien por acá.' });
    expect(screen.getByTestId('tc-detalhe-texto').textContent).toContain('todo bien por acá');
  });

  it('recusada: mostra o motivo E a explicação em prosa da Meta', async () => {
    await abrir({
      metaStatus: 'REJECTED', metaReason: 'INCORRECT_CATEGORY',
      metaDetail: 'La categoría no coincide con el contenido.',
    });
    expect(screen.getByTestId('tc-detalhe-motivo').textContent).toContain('INCORRECT_CATEGORY');
    expect(screen.getByTestId('tc-detalhe-explicacao').textContent).toContain('no coincide');
  });

  it('aprovada: nem motivo nem explicação aparecem — não há o que dizer', async () => {
    await abrir({ metaStatus: 'APPROVED', metaReason: null, metaDetail: null });
    expect(screen.queryByTestId('tc-detalhe-motivo')).toBeNull();
    expect(screen.queryByTestId('tc-detalhe-explicacao')).toBeNull();
  });

  it('mostra as etapas em que a mensagem é usada', async () => {
    await abrir({ usedInStages: ['HIRED', 'SELECTED'] });
    const txt = screen.getByTestId('tc-detalhe-etapas').textContent ?? '';
    expect(txt).toContain('HIRED');
    expect(txt).toContain('SELECTED');
  });

  it('sem uso, diz que não é usada — não deixa em branco', async () => {
    await abrir({ usedInStages: [] });
    expect(screen.getByTestId('tc-detalhe-etapas').textContent).toContain('unused');
  });

  it('inelegível: explica por que não serve para etapas', async () => {
    await abrir({ eligible: false, ineligibleReason: 'PLACEHOLDERS' });
    // O dublê de `t` devolve o fallback quando há 2º argumento — o que importa
    // aqui é que o bloco APARECE e fala de inelegibilidade.
    expect(screen.getByTestId('tc-detalhe-inelegivel').textContent).toContain('ineligible');
  });

  it('elegível não mostra o bloco de "por que não serve"', async () => {
    await abrir({ eligible: true });
    expect(screen.queryByTestId('tc-detalhe-inelegivel')).toBeNull();
  });

  it('nunca verificado diz "nunca", não data vazia', async () => {
    await abrir({ metaCheckedAt: null });
    expect(screen.getByTestId('tc-detalhe-verificado').textContent).toContain('never');
  });

  it('sem content_sid mostra travessão, não "null"', async () => {
    await abrir({ contentSid: null });
    expect(screen.getByTestId('tc-detalhe-sid').textContent).toBe('—');
  });

  it('sem texto sincronizado avisa, em vez de painel vazio', async () => {
    await abrir({ bodyTwilio: null });
    expect(screen.getByTestId('tc-detalhe-texto').textContent).toContain('noText');
  });

  it('Escape fecha o detalhe', async () => {
    const u = await abrir({});
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('tc-detalhe')).toBeNull());
  });
});

describe('ajustes de 01/09 (Gabriel, olhando a tela)', () => {
  describe('a data de verificação, formatada', () => {
    it('ISO vira data legível em es-AR, não string crua', () => {
      const r = dataLegivel('2026-09-01T02:19:00Z');
      expect(r).not.toContain('T');
      expect(r).not.toContain('Z');
      expect(r).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });
    it('null continua null — a tela decide dizer "nunca"', () => {
      expect(dataLegivel(null)).toBeNull();
    });
    it('🔒 ISO inválida vira null, NUNCA "Invalid Date" na tela', () => {
      expect(dataLegivel('nao-e-data')).toBeNull();
      expect(dataLegivel('')).toBeNull();
    });
  });

  it('a data aparece formatada no detalhe', async () => {
    const u = userEvent.setup();
    await renderWith([row({ metaCheckedAt: '2026-09-01T02:19:00Z' })]);
    await u.click(screen.getByTestId('tc-row-ar_bienvenida'));
    await screen.findByTestId('tc-detalhe');
    const txt = screen.getByTestId('tc-detalhe-verificado').textContent ?? '';
    expect(txt).not.toContain('T02:19');
    expect(txt).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('🔒 a linha mostra o IDENTIFICADOR primeiro e a mensagem embaixo', async () => {
    await renderWith([row({ slug: 'ar_bienvenida', bodyTwilio: 'Texto de la mensaje' })]);
    const linha = await screen.findByTestId('tc-row-ar_bienvenida');
    const txt = linha.textContent ?? '';
    // A ordem no DOM é a ordem visual: identificador antes do texto.
    expect(txt.indexOf('ar_bienvenida')).toBeLessThan(txt.indexOf('Texto de la mensaje'));
  });
});

describe('a listagem por MENSAGEM (01/09) — duas colunas de idioma numa linha só', () => {
  const par = [
    row({ slug: 'admission_confirmation_es', baseName: 'admission_confirmation', language: 'es-AR', metaStatus: 'APPROVED' }),
    row({ slug: 'admission_confirmation_pt', baseName: 'admission_confirmation', language: 'pt-BR', metaStatus: 'PENDING' }),
  ];

  it('🔒 as duas versões viram UMA linha — antes eram duas coisas sem relação', async () => {
    await renderWith(par);
    expect(await screen.findByTestId('tc-row-admission_confirmation')).toBeInTheDocument();
    expect(screen.queryByTestId('tc-row-admission_confirmation_es')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tc-row-admission_confirmation_pt')).not.toBeInTheDocument();
  });

  it('🔒 cada idioma carrega o PRÓPRIO estado — aprovado de um lado, em revisão do outro', async () => {
    // As aprovações são independentes: dois Contents, dois pedidos à Meta.
    // Um selo único no par não teria como representar isto.
    await renderWith(par);
    expect(await screen.findByTestId('tc-status-admission_confirmation_es')).toHaveTextContent('APPROVED');
    expect(screen.getByTestId('tc-status-admission_confirmation_pt')).toHaveTextContent('PENDING');
  });

  it('o lado que não existe oferece CRIAR a versão, com o base e o idioma na URL', async () => {
    await renderWith([row({ slug: 'ar_invite_open', baseName: 'invite_open', language: 'es-AR' })]);
    const link = await screen.findByTestId('tc-criar-pt-BR-invite_open');
    expect(link).toHaveAttribute('href', '/admin/plantillas/registrar?base=invite_open&lang=pt-BR');
    // E o lado que existe NÃO oferece criar.
    expect(screen.queryByTestId('tc-criar-es-AR-invite_open')).not.toBeInTheDocument();
  });

  it('o filtro "falta una versión" conta e mostra só as incompletas', async () => {
    const u = userEvent.setup();
    await renderWith([...par, row({ slug: 'ar_invite_open', baseName: 'invite_open', language: 'es-AR' })]);
    const botao = await screen.findByTestId('tc-filter-missing');
    expect(botao).toHaveTextContent('1');
    await u.click(botao);
    expect(screen.getByTestId('tc-row-invite_open')).toBeInTheDocument();
    expect(screen.queryByTestId('tc-row-admission_confirmation')).not.toBeInTheDocument();
  });

  it('🔒 filtro de estado mantém os DOIS lados desenhados — senão o par pareceria incompleto', async () => {
    // Sob "aprobadas", o par entra pelo espanhol. Se a tela filtrasse as linhas
    // soltas antes de agrupar, o português sumiria e a mensagem apareceria como
    // se faltasse uma versão que na verdade está em revisão.
    const u = userEvent.setup();
    await renderWith(par);
    await u.click(await screen.findByTestId('tc-filter-approved'));
    expect(screen.getByTestId('tc-row-admission_confirmation')).toBeInTheDocument();
    expect(screen.getByTestId('tc-status-admission_confirmation_pt')).toHaveTextContent('PENDING');
    expect(screen.queryByTestId('tc-criar-pt-BR-admission_confirmation')).not.toBeInTheDocument();
  });

  it('🔒 idioma não registrado APARECE em vez de sumir das duas colunas', async () => {
    await renderWith([row({ slug: 'qualified_worker', baseName: 'qualified_worker', language: null })]);
    expect(await screen.findByTestId('tc-sem-idioma-qualified_worker')).toHaveTextContent('qualified_worker');
  });
});

describe('os cliques da coluna de idioma', () => {
  it('clicar na versão abre o detalhe DAQUELA versão, não da outra', async () => {
    const u = userEvent.setup();
    await renderWith([
      row({ slug: 'ar_x', baseName: 'x', language: 'es-AR', bodyTwilio: 'texto español' }),
      row({ slug: 'br_x', baseName: 'x', language: 'pt-BR', bodyTwilio: 'texto português' }),
    ]);
    await u.click(screen.getByTestId('tc-lang-pt-BR-br_x'));
    expect(await screen.findByTestId('tc-detalhe')).toHaveTextContent('texto português');
  });

  it('🔒 "＋ Crear versión" NÃO abre o detalhe junto — seriam dois destinos num clique', async () => {
    const u = userEvent.setup();
    await renderWith([row({ slug: 'ar_x', baseName: 'x', language: 'es-AR' })]);
    await u.click(screen.getByTestId('tc-criar-pt-BR-x'));
    expect(screen.queryByTestId('tc-detalhe')).not.toBeInTheDocument();
  });
});
