/**
 * A tela de REGISTRAR mensagem (spec 010, F2 2.1/2.2).
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. **A tela diz que NÃO envia para a Meta.** É o mal-entendido mais caro
 *    possível aqui: a pessoa salvar, achar que submeteu, e esperar autorização
 *    que nunca vem. O aviso é testado, não confiado ao layout.
 * 2. **Não existe botão de submeter.** A ausência é o portão do `lex`.
 * 3. **Erro de regra aparece POR CAMPO**, não como "erro genérico" — a pessoa
 *    precisa saber o que consertar.
 * 4. **Conflito de versão vira aviso legível**, nunca sobrescrita silenciosa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * ⚠️ As telas passaram a ter `<Link>` em 01/09 (o botão que liga o catálogo à
 * tela de criar). Sem Router o React quebra em `basename` — 79 testes caíram de
 * uma vez, e nenhum deles falava de navegação. Envolver aqui mantém os testes
 * medindo o que mediam.
 */
const render = (ui: React.ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

/**
 * Abre o compositor JÁ EDITANDO um rascunho — o caminho que substituiu a lista.
 *
 * 🔒 O bloco "Borradores guardados" saiu desta tela em 01/09 (ele não está na
 * maquete) e as quatro ações foram para o detalhe da mensagem. O que a lista
 * fazia por clique, a URL passou a fazer por endereço: `?draft=<id>`. Os testes
 * abaixo mudaram de PORTA, não de asserção — continuam medindo que o formulário
 * carrega o rascunho, que o PUT leva a `version`, e que o envio passa pela modal.
 */
const abrirEditando = (id = 'id-1') => rtlRender(
  <MemoryRouter initialEntries={[`/admin/plantillas/registrar?draft=${id}`]}>
    <TemplateDraftsPage />
  </MemoryRouter>,
);
import userEvent from '@testing-library/user-event';
import { TemplateDraftsPage } from '../TemplateDraftsPage';
import { DraftApiError, type TemplateDraft } from '@infrastructure/http/AdminTemplateDraftsApiService';

const listDrafts = vi.fn();
const createDraft = vi.fn();
const updateDraft = vi.fn();
const archiveDraft = vi.fn();
const submitDraft = vi.fn();
const validarRascunho = vi.fn();
const duplicateDraft = vi.fn();

vi.mock('@infrastructure/http/AdminTemplateDraftsApiService', async (orig) => {
  const real = await orig<typeof import('@infrastructure/http/AdminTemplateDraftsApiService')>();
  return {
    ...real,
    AdminTemplateDraftsApiService: {
      listDrafts: (...a: unknown[]) => listDrafts(...a),
      createDraft: (...a: unknown[]) => createDraft(...a),
      updateDraft: (...a: unknown[]) => updateDraft(...a),
      archiveDraft: (...a: unknown[]) => archiveDraft(...a),
      submitDraft: (...a: unknown[]) => submitDraft(...a),
      validarRascunho: (...a: unknown[]) => validarRascunho(...a),
      duplicateDraft: (...a: unknown[]) => duplicateDraft(...a),
    },
  };
});

/**
 * Dublê de `t` que imita o i18next em dois modos — o segundo já mordeu o teste
 * da tela vizinha: `t(chave, { slug })` passa um OBJETO como 2º argumento, e um
 * mock ingênuo devolvia o objeto, que React não renderiza.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return `${k}`;
      if (arg && typeof arg === 'object') {
        const vals = Object.values(arg).join(',');
        return `${k}(${vals})`;
      }
      return k;
    },
  }),
}));

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  id: 'id-1', slug: 'ar_bienvenida', baseName: 'bienvenida', name: 'Bienvenida',
  body: 'Hola {{worker_name}}, te esperamos.', category: 'UTILITY', language: 'es-AR',
  version: 1, createdBy: 'uid-a', updatedBy: 'uid-a',
  createdAt: '2026-08-31T12:00:00Z', updatedAt: '2026-08-31T12:00:00Z',
  contentSid: null, submittedAt: null, submittedBy: null, submissionError: null,
  metaStatus: null, metaReason: null, metaDetail: null, metaCheckedAt: null,
  status: 'draft', ...over,
});

/**
 * ⚠️ O corpo entra por `paste`, não por `type`.
 *
 * O `userEvent` trata `{{` como ESCAPE do `{` literal: digitar `Hola {{1}}`
 * produz `Hola {1}}` no campo, e o teste passa a medir um texto que ninguém
 * escreveu. Como esta feature é justamente sobre placeholders `{{n}}`, o escape
 * silencioso arruinaria todos os casos que importam.
 */
const escrever = async (u: ReturnType<typeof userEvent.setup>, testid: string, texto: string) => {
  await u.click(screen.getByTestId(testid));
  await u.paste(texto);
};

/**
 * ⚠️ UM campo de nome, não dois. O compositor (Tela 2) colapsou `name` e `slug`
 * num "Nombre" só — nas 27 linhas de produção `name` é idêntico ao `slug`, e
 * pedir os dois era pedir a mesma coisa duas vezes.
 *
 * Só o espanhol recebe texto: o português fica em branco de propósito, que é o
 * caso normal ("podés enviar solo el español ahora"). Por isso o salvamento
 * grava UMA linha, não duas.
 */
const preencher = async (u: ReturnType<typeof userEvent.setup>) => {
  await u.type(screen.getByTestId('td-input-slug'), 'bienvenida');
  await escrever(u, 'td-input-body', 'Hola {{worker_name}} y chau');
};

beforeEach(() => {
  vi.clearAllMocks();
  listDrafts.mockResolvedValue({ drafts: [] });
  createDraft.mockResolvedValue({ draft: draft() });
  updateDraft.mockResolvedValue({ draft: draft({ version: 2 }) });
  archiveDraft.mockResolvedValue(undefined);
  submitDraft.mockResolvedValue({ submission: { contentSid: 'HXa', slug: 'ar_bienvenida' } });
  // A validação ao vivo é chamada com espera; por padrão devolve tudo limpo.
  validarRascunho.mockResolvedValue({ slug: 'ar_bienvenida', bloqueios: [], avisos: [] });
  // O backend deriva a base do slug NOVO (`baseDoSlug('ar_bienvenida_v2')`), e
  // não herda a do original — herdar faria as duas disputarem o índice único
  // (base_name, language) e a duplicação morreria em 23505.
  duplicateDraft.mockResolvedValue({ draft: draft({ id: 'id-2', slug: 'ar_bienvenida_v2', baseName: 'bienvenida_v2' }) });
});

describe('o perímetro — o que a tela promete e o que não', () => {
  /**
   * ⚠️ O TESTE MUDOU DE ALVO, NÃO DE INTENÇÃO. A promessa ("guardar não envia")
   * continua sendo obrigação da tela; o que saiu foi a CAIXA ÂMBAR que a
   * repetia. Ela dizia o mesmo que o subtítulo já diz e que a modal enumera em
   * cinco pontos — três lugares para uma frase. Aviso repetido não avisa mais:
   * ensina a ignorar a cor. A maquete usa um lugar, e é o subtítulo.
   */
  it('a tela promete, no subtítulo, que salvar NÃO envia para a Meta', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.getByText('admin.templateDrafts.subtitle')).toBeTruthy();
    // 🔒 E a caixa que repetia a mesma frase não voltou.
    expect(screen.queryByTestId('td-aviso-perimetro')).toBeNull();
  });

  it('🔒 enviar NUNCA dispara direto — o clique só abre a confirmação', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    abrirEditando();
    await waitFor(() => expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('bienvenida'));
    await u.click(screen.getByTestId('td-revisar-enviar'));
    expect(screen.getByTestId('td-confirmar')).toBeTruthy();
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it('🔒 sem rascunho gravado, "revisar y enviar" está TRAVADO', async () => {
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-revisar-enviar')).toBeTruthy());
    // Submeter algo que ainda não está no banco criaria um Content na Twilio
    // sem linha nossa apontando para ele — órfão que nenhuma tela mostraria.
    expect((screen.getByTestId('td-revisar-enviar') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('salvar', () => {
  it('cria o rascunho com o que foi digitado', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0][0]).toMatchObject({
      name: 'bienvenida', slug: 'bienvenida', category: 'UTILITY', language: 'es-AR',
    });
    // 🔒 UMA chamada, não duas: o português está em branco e rascunho de corpo
    // vazio seria recusado (`body.obrigatorio`) — "ainda não traduzi" viraria erro.
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it('🔒 aviso de regra aparece DEPOIS de salvar, em âmbar, sem travar nada', async () => {
    // AR-01: gravou sem cláusula de baja. Se este painel não existisse, a regra
    // não teria por onde chegar — o backend só devolve aviso no 200/201, e a
    // tela até 01/09 só olhava `problemas` dentro de um `catch`.
    createDraft.mockResolvedValue({
      draft: draft(),
      avisos: [{ campo: 'body', regra: 'sem_clausula_de_baja', gravidade: 'aviso' as const }],
    });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-avisos').textContent)
      .toContain('admin.templateDrafts.regra.body.sem_clausula_de_baja'));
    // ...e o salvamento CONTINUA sendo um sucesso. Aviso não é recusa.
    expect(screen.getByTestId('td-salvo')).toBeTruthy();
    expect(screen.queryByTestId('td-problemas-body')).toBeNull();
  });

  it('sem aviso, o painel âmbar não existe — não é um cartaz permanente', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-salvo')).toBeTruthy());
    expect(screen.queryByTestId('td-avisos')).toBeNull();
  });

  it('depois de salvar diz "guardado, ainda NÃO enviado" — nunca só "salvo"', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-salvo').textContent)
      .toContain('admin.templateDrafts.salvoNaoEnviado'));
  });

  it('recarrega a lista depois de salvar', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(1));
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(2));
  });

  /**
   * 🔒 OS DOIS SLUGS NASCEM JUNTOS. Antes a tela mostrava um só, o do idioma
   * escolhido no `<select>`; o desenho mostra o par, porque "quase sempre a
   * mesma mensagem precisa existir dos dois lados" e ver isso na hora é o que
   * evita cadastrar duas mensagens que ninguém depois relaciona.
   */
  it('o nome digitado uma vez faz nascer o PAR ar_/br_', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await u.type(screen.getByTestId('td-input-slug'), 'bienvenida');
    // O selo carrega o prefixo; o texto, a base. O slug inteiro — que é o que
    // fica ocupado na conta de WhatsApp — segue afirmado, em `data-slug`.
    expect(screen.getByTestId('td-slug-es-AR').textContent).toBe('bienvenida');
    expect(screen.getByTestId('td-slug-pt-BR').textContent).toBe('bienvenida');
    expect(screen.getByTestId('td-par-slug-es-AR')).toHaveAttribute('data-slug', 'ar_bienvenida');
    expect(screen.getByTestId('td-par-slug-pt-BR')).toHaveAttribute('data-slug', 'br_bienvenida');
  });

  it('sem nome, o par não aparece — não mostra "ar_" sozinho', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.queryByTestId('td-par-slugs')).toBeNull();
  });

  it('a pré-visualização troca a variável por um valor de exemplo', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola {{worker_name}}!');
    expect(screen.getByTestId('td-preview-texto').textContent).toContain('María González');
  });

  /**
   * 🔒 O TOKEN DESCONHECIDO FICA CRU. A pré-visualização não inventa valor para
   * o que o sistema não sabe preencher: a pessoa precisa VER que aquilo não vai
   * ser preenchido, senão escreve uma mensagem que a Meta aprova e que a Twilio
   * recusa no envio por "Content Variables parameter is invalid".
   */
  it('variável que o sistema não conhece aparece CRUA na pré-visualização', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola {{apellido}}!');
    expect(screen.getByTestId('td-preview-texto').textContent).toContain('{{apellido}}');
  });

  it('sem texto, o balão diz que está vazio em vez de ficar em branco', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.getByTestId('td-preview-vazio')).toBeTruthy();
  });

  /**
   * O contador conta o que JÁ FOI escrito ("218 / 1024"), como no desenho — é a
   * leitura que responde "cabe?" de relance. A anterior mostrava o que sobra, e
   * passar do limite virava um número negativo, que ninguém lê como "excedi".
   */
  it('o contador mostra escrito / limite', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'abc');
    expect(screen.getByTestId('td-restante').textContent).toBe('3 / 1024');
  });

  it('passar do limite pinta de vermelho — sem isso só o 422 avisaria', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'a'.repeat(1030));
    const span = screen.getByTestId('td-restante');
    expect(span.textContent).toBe('1030 / 1024');
    expect(span.parentElement?.className).toContain('text-red-700');
  });
});

describe('quando o servidor recusa', () => {
  it('422 mostra a regra violada NO CAMPO, não como erro genérico', async () => {
    createDraft.mockRejectedValue(new DraftApiError('rejeitado', 422, null, [
      { campo: 'body', regra: 'placeholder_no_fim', gravidade: 'bloqueia' as const },
    ]));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-problemas-body').textContent)
      .toContain('admin.templateDrafts.regra.body.placeholder_no_fim'));
    // Regra violada NÃO vira erro genérico no topo: ela fica no campo.
    expect(screen.queryByTestId('td-erro')).toBeNull();
  });

  it('vários problemas no corpo aparecem TODOS, não só o primeiro', async () => {
    createDraft.mockRejectedValue(new DraftApiError('rejeitado', 422, null, [
      { campo: 'body', regra: 'placeholder_no_inicio', gravidade: 'bloqueia' as const },
      { campo: 'body', regra: 'placeholder_no_fim', gravidade: 'bloqueia' as const },
    ]));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-problemas-body').children).toHaveLength(2));
  });

  it('409 de versão vira aviso legível — nunca sobrescreve em silêncio', async () => {
    updateDraft.mockRejectedValue(new DraftApiError('conflito', 409, 'versao_desatualizada', [], 7));
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    abrirEditando();
    await waitFor(() => expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('bienvenida'));
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.conflito.versao_desatualizada'));
  });

  it('409 de slug em uso nomeia QUAL colisão foi', async () => {
    createDraft.mockRejectedValue(new DraftApiError('conflito', 409, 'slug_em_uso_por_template_vivo'));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('conflito.slug_em_uso_por_template_vivo'));
  });

  it('500 mostra a mensagem do servidor', async () => {
    createDraft.mockRejectedValue(new DraftApiError('boom interno', 500));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent).toContain('boom interno'));
  });

  it('erro que não é da API cai no texto genérico de salvar', async () => {
    createDraft.mockRejectedValue(new Error('rede caiu'));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroSalvar'));
  });

  it('falha ao carregar avisa, e o formulário continua utilizável', async () => {
    listDrafts.mockRejectedValue(new Error('down'));
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroCarregar'));
    /*
     * 🔒 A tela NÃO fica em branco. A leitura dos rascunhos só serve para abrir
     * um por `?draft=`; compor uma mensagem nova não depende dela, e travar o
     * formulário por causa de uma listagem que falhou seria perder o trabalho
     * de quem só queria escrever.
     */
    expect(screen.getByTestId('td-form')).toBeTruthy();
    expect((screen.getByTestId('td-salvar') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('abrir um rascunho salvo — a porta é a URL, não uma lista', () => {
  /*
   * 🔒 ARQUIVAR E DUPLICAR NÃO ESTÃO MAIS AQUI. As duas — e o estado de cada
   * rascunho, e a última falha de envio — foram para o detalhe da mensagem, e
   * os testes foram junto (`TemplateCatalogDetailPage.test.tsx`, bloco "as
   * ações de um rascunho"). O que este arquivo continua provando é o que esta
   * tela continua fazendo: compor, e gravar o que foi composto.
   */
  it('`?draft=id` carrega o rascunho no formulário e manda a version no PUT', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({ version: 4 })] });
    const u = userEvent.setup();
    abrirEditando();
    await waitFor(() => expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('bienvenida'));
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(updateDraft).toHaveBeenCalledWith('id-1', expect.objectContaining({ version: 4 })));
  });

  it('🔒 `?draft=` de id que não existe NÃO trava a tela — abre em branco', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    rtlRender(
      <MemoryRouter initialEntries={['/admin/plantillas/registrar?draft=nao-existe']}>
        <TemplateDraftsPage />
      </MemoryRouter>,
    );
    // O rascunho pode ter sido arquivado entre copiar o link e abri-lo. Um erro
    // aqui seria sobre um id, não sobre o que a pessoa quer fazer agora.
    await waitFor(() => expect(listDrafts).toHaveBeenCalled());
    expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('td-erro')).toBeNull();
  });

  it('🔒 recarregar a lista NÃO apaga o que está sendo digitado', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    abrirEditando();
    await waitFor(() => expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('bienvenida'));
    await u.clear(screen.getByTestId('td-input-slug'));
    await u.type(screen.getByTestId('td-input-slug'), 'outro_nombre');
    // `salvar` recarrega os rascunhos; sem a trava de "abrir uma vez só", a
    // segunda resposta reescreveria o formulário com o texto ANTIGO.
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(listDrafts).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).not.toBe('bienvenida');
  });

  it('cancelar a edição limpa o formulário', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    abrirEditando();
    await waitFor(() => expect(screen.getByTestId('td-cancelar')).toBeTruthy());
    await u.click(screen.getByTestId('td-cancelar'));
    expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('td-cancelar')).toBeNull();
  });

  it('escrever na aba do português grava a versão br_', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await u.type(screen.getByTestId('td-input-slug'), 'boas_vindas');
    await u.click(screen.getByTestId('td-aba-pt-BR'));
    await escrever(u, 'td-input-body', 'Olá {{worker_name}}, tudo bem');
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0][0]).toMatchObject({ language: 'pt-BR', slug: 'boas_vindas' });
  });

  /**
   * 🔒 O PAR INTEIRO NUMA GRAVAÇÃO SÓ. É a razão de a tela existir: escrever a
   * mesma mensagem nas duas línguas era, antes, dois cadastros separados que
   * nada relacionava.
   */
  it('com texto nos dois idiomas, grava as DUAS versões', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await u.type(screen.getByTestId('td-input-slug'), 'boas_vindas');
    await escrever(u, 'td-input-body', 'Hola {{worker_name}}, todo bien');
    await u.click(screen.getByTestId('td-aba-pt-BR'));
    await escrever(u, 'td-input-body', 'Olá {{worker_name}}, tudo bem');
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(2));
    expect(createDraft.mock.calls.map((c) => c[0].language).sort()).toEqual(['es-AR', 'pt-BR']);
  });

  /**
   * 🔒 A CATEGORIA É DERIVADA, não perguntada. O desenho: "ninguém precisa
   * saber o que é UTILITY". A pessoa escolhe o TIPO e a tela traduz.
   */
  it('escolher "difusión" grava MARKETING sem a pessoa ver a palavra', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-tipo-difusion'));
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft.mock.calls[0][0].category).toBe('MARKETING'));
  });

  it('o padrão "aviso del proceso" grava UTILITY', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft.mock.calls[0][0].category).toBe('UTILITY'));
  });
});

describe('enviar para autorização — o ato irreversível', () => {
  const abrirConfirmacao = async (u: ReturnType<typeof userEvent.setup>) => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    abrirEditando();
    await waitFor(() => expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value).toBe('bienvenida'));
    await u.click(screen.getByTestId('td-revisar-enviar'));
  };

  /**
   * Marca "li o texto e confirmo".
   *
   * 🔒 Está num helper SEPARADO de propósito, e não dentro de `abrirConfirmacao`.
   * Se abrir já marcasse, nenhum teste exercitaria a modal com o botão travado —
   * e a trava é justamente o que este bloco existe para provar.
   */
  const marcarLi = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.click(screen.getByTestId('td-confirmar-li'));
  };

  it('a confirmação ENUMERA o que se torna irreversível — não é "tem certeza?"', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    expect(screen.getByTestId('td-confirmar-lista').children).toHaveLength(5);
    const texto = screen.getByTestId('td-confirmar-lista').textContent ?? '';
    expect(texto).toContain('confirmar.nome');
    expect(texto).toContain('confirmar.edicao');
    expect(texto).toContain('confirmar.prazo');
    expect(texto).toContain('confirmar.idiomaFixo');
    expect(texto).toContain('confirmar.soUmIdioma');
  });

  /**
   * 🔒 O CONTROLE POSITIVO DA TRAVA. Sem este teste o checkbox é decoração: a
   * suíte inteira marcaria a caixa antes de clicar e nunca exercitaria o estado
   * em que o botão TEM de recusar. Aqui o clique acontece com a caixa em branco
   * e a asserção é sobre `submitDraft` — não sobre a aparência do botão.
   */
  it('sem marcar "li o texto", o botão está travado e o clique NÃO envia', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    const enviar = screen.getByTestId('td-confirmar-sim') as HTMLButtonElement;
    expect(enviar.disabled).toBe(true);
    await u.click(enviar);
    expect(submitDraft).not.toHaveBeenCalled();
    // e a modal continua aberta: nada aconteceu, e a pessoa vê por quê.
    expect(screen.getByTestId('td-confirmar')).toBeTruthy();
  });

  it('marcar "li o texto" destrava o envio', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    expect((screen.getByTestId('td-confirmar-sim') as HTMLButtonElement).disabled).toBe(true);
    await marcarLi(u);
    expect((screen.getByTestId('td-confirmar-sim') as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * O recap existe para a pessoa reler o que está confirmando. Sem ele a caixa
   * "li o texto" pergunta sobre algo que não está na tela.
   */
  it('a modal mostra O QUE vai ser enviado — slug, idioma, categoria e o texto', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    const recap = screen.getByTestId('td-confirmar-recap').textContent ?? '';
    expect(recap).toContain('ar_bienvenida');
    expect(recap).toContain('admin.templateDrafts.idioma.es-AR');
    expect(recap).toContain('UTILITY');
  });

  it('cancelar fecha e NÃO envia', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await u.click(screen.getByTestId('td-confirmar-nao'));
    expect(screen.queryByTestId('td-confirmar')).toBeNull();
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it('confirmar envia e avisa que agora é esperar', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await marcarLi(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(submitDraft).toHaveBeenCalledWith('id-1'));
    await waitFor(() => expect(screen.getByTestId('td-salvo').textContent)
      .toContain('admin.templateDrafts.enviado'));
  });

  it('🔒 503 diz QUAL motivo — flag desligada ou credencial faltando', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('x', 503, 'submissao_indisponivel', [], null, 'flag_desligada'));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await marcarLi(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('indisponivel.flag_desligada'));
  });

  it('502 da Twilio vira mensagem nomeada, não erro cru', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('x', 502, 'twilio_falhou'));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await marcarLi(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('envioErro.twilio_falhou'));
  });

  it('422 no envio fecha a confirmação e mostra a regra no campo', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('x', 422, null, [{ campo: 'body', regra: 'placeholder_posicional', gravidade: 'bloqueia' as const }]));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await marcarLi(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.queryByTestId('td-confirmar')).toBeNull());
    expect(screen.getByTestId('td-problemas-body').textContent).toContain('placeholder_posicional');
  });

  it('erro sem código cai na mensagem do servidor', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('caiu tudo', 500, null));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await marcarLi(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent).toContain('caiu tudo'));
  });

  it('erro que não é da API cai no texto genérico', async () => {
    submitDraft.mockRejectedValue(new Error('rede'));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await marcarLi(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroEnviar'));
  });
});

describe('as variáveis', () => {
  /*
   * 🔒 O QUE ERA "depois de submetido" MUDOU DE ARQUIVO, não sumiu. Estado do
   * rascunho, veredito da Meta, motivo da recusa, última falha de envio,
   * duplicar e a recusa de editar o que já foi submetido: tudo isso agora vive
   * no detalhe da mensagem, e é lá que está testado. Aqui ficou o que continua
   * sendo desta tela.
   */

  /**
   * 🔒 A VARIÁVEL ENTRA POR BOTÃO. Um template aprovado rejeita variável vazia —
   * a Twilio devolve "Content Variables parameter is invalid" e a mensagem
   * inteira não sai. Pelo botão o conjunto é fechado por construção: não há como
   * escrever uma variável que o sistema não saiba preencher.
   */
  it('oferece as variáveis como BOTÃO, não como texto para copiar', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.getByTestId('td-inserir-worker_name')).toBeTruthy();
    expect(screen.getByTestId('td-inserir-case_number')).toBeTruthy();
  });

  /**
   * 🔒 O QUE SE VÊ E O QUE SE ENVIA SÃO COISAS DIFERENTES — e as duas são
   * afirmadas aqui. Na tela a variável é um CHIP com o rótulo amigável, porque
   * `worker_name` é vocabulário de banco e esta tela existe para parar de
   * exigi-lo de quem escreve. No corpo que vai à Meta é `{{worker_name}}`, que
   * é o que a Twilio sabe preencher. Testar só um dos dois deixaria passar
   * justamente o erro que importa: o chip bonito com o token errado embaixo.
   */
  it('clicar no botão põe um CHIP na tela', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola ');
    await u.click(screen.getByTestId('td-inserir-worker_name'));
    const chip = screen.getByTestId('td-chip-worker_name');
    expect(chip.textContent).toContain('variavel.worker_name');
    // Atômico: apagar uma letra do meio produziria `{{worker_nam}}`, que a Meta
    // aprova e a Twilio recusa na hora de enviar.
    expect(chip.getAttribute('contenteditable')).toBe('false');
    expect(screen.getByTestId('td-input-body').textContent).not.toContain('{{');
  });

  it('e o que vai para a Meta continua sendo o token cru', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await u.type(screen.getByTestId('td-input-slug'), 'bienvenida');
    await escrever(u, 'td-input-body', 'Hola ');
    await u.click(screen.getByTestId('td-inserir-worker_name'));
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Hola {{worker_name}}' }),
    ));
  });

  it('colar um texto com o token já entrega o chip', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    // Colar é o caminho de quem traz a mensagem de outro lugar — e é o mesmo
    // construtor de nós do botão, então o chip nasce na hora.
    await escrever(u, 'td-input-body', 'Hola {{worker_name}}');
    expect(screen.getByTestId('td-chip-worker_name')).toBeTruthy();
  });

  it('quem DIGITA o token à mão ganha o chip ao sair do campo', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    // `{{{{` porque o `userEvent` trata `{{` como escape do `{` literal.
    await u.click(screen.getByTestId('td-input-body'));
    await u.keyboard('Hola {{{{worker_name}}');
    /*
     * Enquanto digita, o texto é o que ela digitou: reescrever o DOM a cada
     * tecla moveria o cursor no meio da palavra. A conversão espera o campo
     * perder o foco — sem ela o mesmo texto apareceria de dois jeitos, cru
     * enquanto digitado e chip depois de recarregar a página.
     */
    expect(screen.queryByTestId('td-chip-worker_name')).toBeNull();
    await u.click(screen.getByTestId('td-input-slug'));
    await waitFor(() => expect(screen.getByTestId('td-chip-worker_name')).toBeTruthy());
  });

  it('🔒 variável que o sistema NÃO conhece fica crua — não vira chip', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola {{foo}}');
    // Um chip bonito prometeria um preenchimento que não vai acontecer: a
    // Twilio devolve "Content Variables parameter is invalid" e a mensagem
    // inteira não sai. Mesma regra da pré-visualização.
    expect(screen.getByTestId('td-input-body').textContent).toContain('{{foo}}');
    expect(screen.queryByTestId('td-chip-foo')).toBeNull();
  });
});

describe('as duas ações que o desenho tem no editor', () => {
  /**
   * 🔒 A CLÁUSULA USA UMA PALAVRA QUE O INBOUND HONRA. Não é detalhe de copy:
   * `optOutMatch.OPT_OUT_EXACT` contém `baja`, e um texto que PROMETE uma saída
   * com palavra que o inbound não reconhece é pior que não prometer nada — quem
   * responder não é dado de baixa e ninguém fica sabendo. É a mesma classe de
   * defeito que a regra AR-01 do backend existe para pegar.
   */
  it('o botão de cláusula insere um texto com a palavra que dá baixa', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola');
    await u.click(screen.getByTestId('td-inserir-clausula'));
    const v = screen.getByTestId('td-input-body').textContent ?? '';
    expect(v).toContain('Hola');
    expect(v.toLowerCase()).toContain('baja');
  });

  /**
   * Sem isto, "falta o texto no outro idioma" é cobrança sem saída: a pessoa
   * teria de selecionar, copiar, trocar de aba e colar.
   */
  it('copiar para traduzir leva o texto à outra aba e vai para ela', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola, bienvenida');
    await u.click(screen.getByTestId('td-copiar-para-traduzir'));
    // Agora a aba ativa é a portuguesa, com o texto copiado por cima do qual traduzir.
    expect(screen.getByTestId('td-input-body').textContent).toBe('Hola, bienvenida');
    expect(screen.getByTestId('td-aba-pt-BR').getAttribute('aria-selected')).toBe('true');
  });

  it('sem texto nenhum, não oferece copiar — não há o que traduzir', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.queryByTestId('td-copiar-para-traduzir')).toBeNull();
  });
});
