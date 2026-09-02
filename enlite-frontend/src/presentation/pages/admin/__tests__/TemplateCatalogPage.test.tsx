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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { dataLegivel } from '../templateCatalogView';

/**
 * ⚠️ As telas passaram a ter `<Link>` em 01/09 (o botão que liga o catálogo à
 * tela de criar). Sem Router o React quebra em `basename` — 79 testes caíram de
 * uma vez, e nenhum deles falava de navegação. Envolver aqui mantém os testes
 * medindo o que mediam.
 */
/**
 * A sonda de destino. A lista deixou de abrir um drawer e passou a NAVEGAR para
 * `/admin/plantillas/:slug` (Tela 4 do desenho). Sem uma rota de chegada, o
 * clique levaria a lugar nenhum e o teste não teria como afirmar PARA ONDE foi —
 * ele passaria por não ter olhado.
 */
function SondaDetalhe(): JSX.Element {
  const { slug } = useParams<{ slug: string }>();
  return <div data-testid="sonda-detalhe">{slug}</div>;
}

const render = (ui: React.ReactElement) => rtlRender(
  <MemoryRouter initialEntries={['/admin/plantillas']}>
    <Routes>
      <Route path="/admin/plantillas" element={ui} />
      {/* ⚠️ A rota ESTÁTICA vem antes da paramétrica, como no `App.tsx`. Sem
          ela, `/admin/plantillas/registrar` casaria com `:slug` e a sonda de
          detalhe apareceria com slug "registrar" — o teste mediria uma
          navegação que o app real nunca faz. */}
      <Route path="/admin/plantillas/registrar" element={<div data-testid="sonda-registrar" />} />
      <Route path="/admin/plantillas/:slug" element={<SondaDetalhe />} />
    </Routes>
  </MemoryRouter>,
);
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
let idiomaDoPerfil = 'es';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, arg?: string | Record<string, unknown>) =>
      typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? `${k}:${JSON.stringify(arg)}` : k,
    // ⚠️ O `i18n` faz parte da forma do hook REAL, e o dublê precisa tê-lo: a
    // listagem escolhe qual versão da mensagem mostrar pelo idioma do perfil
    // (`i18n.language`). Sem ele o componente estourava e TODAS as linhas
    // sumiam — 20 testes caíram de uma vez, nenhum deles sobre idioma.
    // `idiomaDoPerfil` abaixo deixa cada teste escolher o perfil.
    i18n: { language: idiomaDoPerfil },
  }),
}));

const row = (over: Partial<TemplateCatalogRow> = {}): TemplateCatalogRow => ({
  slug: 'ar_bienvenida', name: 'ar_bienvenida', bodyTwilio: 'Hola María, bienvenida',
  language: 'es-AR',
  category: 'UTILITY', isActive: true, contentSid: 'HXaaa',
  metaStatus: 'APPROVED', metaReason: null, metaDetail: null,
  metaCheckedAt: '2026-08-31T12:00:00Z',
  eligible: true, ineligibleReason: null, placeholders: [], usedInStages: [],
  isDraft: false,
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
    /**
     * ⚠️ ESTE TESTE FOI INVERTIDO, e a medição que o criou continua válida.
     *
     * Em 01/09 as variáveis saíram da lista porque, nos 27 templates antigos
     * (posicionais), a célula virava "1 2 3 4 5" — números nus que não ensinam
     * nada. O desenho de 31/08 pede os chips de volta, e a diferença está na
     * FORMA: o chip mostra `{{1}}`, que se lê como marcador de posição, e não
     * um algarismo solto. O que a lista NÃO faz é explicar o custo daquilo —
     * isso continua no detalhe, onde há espaço para a frase.
     */
    it('a listagem mostra as variáveis como CHIP, não como número nu', async () => {
      await renderWith([row({ placeholders: ['1', '2'] })]);
      const chips = await screen.findByTestId('tc-vars-ar_bienvenida');
      expect(chips.textContent).toContain('{{1}}');
      expect(chips.textContent).not.toBe('1 2');
    });

    it('sem variáveis não desenha o bloco de chips', async () => {
      await renderWith([row({ placeholders: [] })]);
      await screen.findByTestId('tc-table');
      expect(screen.queryByTestId('tc-vars-ar_bienvenida')).not.toBeInTheDocument();
    });

    /**
     * 🔒 O QUE A LISTA FAZ HOJE É NAVEGAR. O detalhe virou rota própria, e o que
     * esta camada tem de garantir é só isto: o clique leva ao slug CERTO. O que
     * a tela de destino mostra é medido em `TemplateCatalogDetailPage.test.tsx`,
     * para onde as asserções de conteúdo migraram inteiras.
     */
    it('clicar na linha leva ao detalhe DAQUELA mensagem', async () => {
      const u = userEvent.setup();
      await renderWith([row({ placeholders: ['1', '2'] })]);
      await u.click(screen.getByTestId('tc-row-ar_bienvenida'));
      expect((await screen.findByTestId('sonda-detalhe')).textContent).toBe('ar_bienvenida');
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

  /**
   * ⚠️ A COLUNA DE DATA SAIU DA LISTA (desenho de 31/08). A informação não se
   * perdeu: a idade do dado está na faixa de filtros e vale para a lista
   * inteira — o sync roda de uma vez — e a data de UMA mensagem está no
   * detalhe, medida em `TemplateCatalogDetailPage.test.tsx`. O que este teste
   * garante agora é que ela NÃO voltou a repetir a mesma data em toda linha.
   */
  it('a lista não repete a data de verificação em cada linha', async () => {
    await renderWith([row(), row({ slug: 'ar_outra', baseName: 'outra' })]);
    await screen.findByTestId('tc-table');
    expect(screen.queryAllByText(/31\/08\/2026/)).toHaveLength(0);
  });
});

/*
 * ⚠️ O bloco "o detalhe da mensagem — os campos que só ele mostra" (15 testes)
 * NÃO foi apagado: migrou inteiro para `TemplateCatalogDetailPage.test.tsx`
 * quando o drawer virou rota. Motivo, explicação, variáveis, uso,
 * elegibilidade, data e SID continuam sendo medidos, palavra por palavra — só
 * que na tela onde agora moram.
 */

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

  /**
   * ⚠️ INVERTIDO em 01/09 pelo desenho, e a razão da inversão é a mesma que
   * motivou a ordem anterior: `name` é idêntico ao `slug` nas 27 linhas de
   * produção, então o identificador não diz o que a mensagem faz. A emenda de
   * antes o pôs em primeiro porque não havia SEGUNDO lugar mostrando o nome;
   * agora há — a coluna de idioma traz o slug de cada versão. O texto lidera, e
   * o identificador continua na linha, uma linha abaixo.
   */
  it('🔒 a linha mostra o TEXTO primeiro e o identificador embaixo', async () => {
    await renderWith([row({ slug: 'ar_bienvenida', bodyTwilio: 'Texto de la mensaje' })]);
    const linha = await screen.findByTestId('tc-row-ar_bienvenida');
    const txt = linha.textContent ?? '';
    expect(txt.indexOf('Texto de la mensaje')).toBeLessThan(txt.indexOf('ar_bienvenida'));
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

  /**
   * ⚠️ INVERTIDO pelo desenho, com a objeção medida resolvida de outro jeito.
   *
   * A objeção era real: 24 das 26 mensagens não têm versão em português, e a
   * coluna virava uma parede da MESMA chamada para ação — transformando o
   * estado NORMAL (o Brasil não está ligado) em alarme. O que conserta isso é o
   * PESO, não a ausência: link discreto, sem cor de alerta e sem borda. Este
   * teste trava o peso, que é a parte que pode regredir sem ninguém notar.
   */
  it('o lado que falta OFERECE criar a versão — em link discreto, não em botão', async () => {
    await renderWith([row({ slug: 'ar_invite_open', baseName: 'invite_open', language: 'es-AR' })]);
    const link = await screen.findByTestId('tc-criar-pt-BR-invite_open');
    expect(link.getAttribute('href')).toBe('/admin/plantillas/registrar?base=invite_open&lang=pt-BR');
    // 🔒 Sem cor de alerta e sem borda: oferece, não cobra.
    expect(link.className).not.toContain('bg-pink');
    expect(link.className).not.toContain('border');
  });

  /*
   * ⚠️ "a AÇÃO de criar a versão que falta" e "par completo não mostra ação"
   * migraram para `TemplateCatalogDetailPage.test.tsx`: a ação mora na tela de
   * detalhe, e é lá que ela tem de ser medida. O que fica aqui é o que é da
   * LISTA — que a linha leva ao slug certo.
   */
  it('clicar na linha do par leva à versão PRINCIPAL da mensagem', async () => {
    const u = userEvent.setup();
    await renderWith([row({ slug: 'ar_invite_open', baseName: 'invite_open', language: 'es-AR' })]);
    await u.click(screen.getByTestId('tc-row-invite_open'));
    expect((await screen.findByTestId('sonda-detalhe')).textContent).toBe('ar_invite_open');
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
  it('clicar na versão leva ao detalhe DAQUELA versão, não da outra', async () => {
    const u = userEvent.setup();
    await renderWith([
      row({ slug: 'ar_x', baseName: 'x', language: 'es-AR', bodyTwilio: 'texto español' }),
      row({ slug: 'br_x', baseName: 'x', language: 'pt-BR', bodyTwilio: 'texto português' }),
    ]);
    await u.click(screen.getByTestId('tc-lang-pt-BR-br_x'));
    // 🔒 O slug do DESTINO é a prova: `br_x`, não `ar_x`. Antes isto se media
    // pelo texto dentro do drawer; agora se mede pela rota, que é mais forte —
    // texto igual nas duas versões passaria batido, slug não.
    expect((await screen.findByTestId('sonda-detalhe')).textContent).toBe('br_x');
  });

  it('e clicar na versão espanhola leva à espanhola — cada coluna leva à SUA', async () => {
    const u = userEvent.setup();
    await renderWith([
      row({ slug: 'ar_x', baseName: 'x', language: 'es-AR', bodyTwilio: 'texto español' }),
      row({ slug: 'br_x', baseName: 'x', language: 'pt-BR', bodyTwilio: 'texto português' }),
    ]);
    await u.click(screen.getByTestId('tc-lang-es-AR-ar_x'));
    expect((await screen.findByTestId('sonda-detalhe')).textContent).toBe('ar_x');
  });

  /**
   * 🔒 O CLIQUE NA CÉLULA VAZIA NÃO PODE VAZAR PARA A LINHA. A linha navega
   * para o detalhe; a célula oferece criar a versão. Sem o `stopPropagation` os
   * dois disparam e a pessoa acaba no detalhe da versão espanhola, sem entender
   * por que o "criar versão" não funcionou.
   */
  it('clicar em "criar versión" NÃO abre também o detalhe da linha', async () => {
    const u = userEvent.setup();
    await renderWith([row({ slug: 'ar_x', baseName: 'x', language: 'es-AR' })]);
    await u.click(await screen.findByTestId('tc-criar-pt-BR-x'));
    expect(await screen.findByTestId('sonda-registrar')).toBeTruthy();
    expect(screen.queryByTestId('sonda-detalhe')).toBeNull();
  });
});

describe('o texto da lista segue o idioma do perfil (emenda do Gabriel, 01/09)', () => {
  const par = [
    row({ slug: 'ar_x', baseName: 'x', language: 'es-AR', bodyTwilio: 'texto en español' }),
    row({ slug: 'br_x', baseName: 'x', language: 'pt-BR', bodyTwilio: 'texto em português' }),
  ];
  afterEach(() => { idiomaDoPerfil = 'es'; });

  it('perfil em espanhol lê o texto argentino', async () => {
    idiomaDoPerfil = 'es';
    await renderWith(par);
    expect(screen.getByTestId('tc-row-x')).toHaveTextContent('texto en español');
  });

  it('🔒 perfil em português lê o texto BRASILEIRO — a versão existia ali do lado', async () => {
    idiomaDoPerfil = 'pt-BR';
    await renderWith(par);
    expect(screen.getByTestId('tc-row-x')).toHaveTextContent('texto em português');
  });
});
