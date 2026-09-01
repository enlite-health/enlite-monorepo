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
import userEvent from '@testing-library/user-event';
import { TemplateDraftsPage } from '../TemplateDraftsPage';
import { DraftApiError, type TemplateDraft } from '@infrastructure/http/AdminTemplateDraftsApiService';

const listDrafts = vi.fn();
const createDraft = vi.fn();
const updateDraft = vi.fn();
const archiveDraft = vi.fn();
const submitDraft = vi.fn();
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
  id: 'id-1', slug: 'ar_bienvenida', name: 'Bienvenida',
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

const preencher = async (u: ReturnType<typeof userEvent.setup>) => {
  await u.type(screen.getByTestId('td-input-name'), 'Bienvenida');
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
  duplicateDraft.mockResolvedValue({ draft: draft({ id: 'id-2', slug: 'ar_bienvenida_v2' }) });
});

describe('o perímetro — o que a tela promete e o que não', () => {
  it('avisa, com texto próprio, que salvar NÃO envia para a Meta', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.getByTestId('td-aviso-perimetro').textContent)
      .toContain('admin.templateDrafts.avisoNaoEnvia');
  });

  it('🔒 enviar NUNCA dispara direto — o clique só abre a confirmação', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-enviar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-enviar-ar_bienvenida'));
    expect(screen.getByTestId('td-confirmar')).toBeTruthy();
    expect(submitDraft).not.toHaveBeenCalled();
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
      name: 'Bienvenida', slug: 'bienvenida', category: 'UTILITY', language: 'es-AR',
    });
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

  it('mostra o slug que VAI ser gravado antes de gravar', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await u.type(screen.getByTestId('td-input-slug'), 'bienvenida');
    expect(screen.getByTestId('td-slug-previsto').textContent).toContain('ar_bienvenida');
  });

  it('a pré-visualização troca a variável por exemplo legível', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'Hola {{worker_name}}!');
    expect(screen.getByTestId('td-preview').textContent).toContain('[nombre]');
  });

  it('passar do limite mostra contagem NEGATIVA e pinta de vermelho', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'a'.repeat(1030));
    const span = screen.getByTestId('td-restante');
    expect(span.textContent).toContain('-6');
    // O vermelho é o sinal; sem ele a pessoa só descobre no 422 do servidor.
    expect(span.parentElement?.className).toContain('text-red-700');
  });

  it('mostra quanto ainda cabe', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await escrever(u, 'td-input-body', 'abc');
    expect(screen.getByTestId('td-restante').textContent).toContain('1021');
  });
});

describe('quando o servidor recusa', () => {
  it('422 mostra a regra violada NO CAMPO, não como erro genérico', async () => {
    createDraft.mockRejectedValue(new DraftApiError('rejeitado', 422, null, [
      { campo: 'body', regra: 'placeholder_no_fim' },
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
      { campo: 'body', regra: 'placeholder_no_inicio' },
      { campo: 'body', regra: 'placeholder_no_fim' },
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
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-item-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-editar-ar_bienvenida'));
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

  it('falha ao carregar mostra aviso e lista vazia, não tela em branco', async () => {
    listDrafts.mockRejectedValue(new Error('down'));
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroCarregar'));
    expect(screen.getByTestId('td-vazio')).toBeTruthy();
  });
});

describe('lista e edição', () => {
  it('mostra "carregando" antes da resposta e o vazio depois', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.getByTestId('td-carregando')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('td-vazio')).toBeTruthy());
  });

  it('lista os rascunhos salvos', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft(), draft({ id: 'id-2', slug: 'br_boas_vindas' })] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-lista').children).toHaveLength(2));
  });

  it('editar carrega o rascunho no formulário e manda a version no PUT', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({ version: 4 })] });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-editar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-editar-ar_bienvenida'));
    expect((screen.getByTestId('td-input-name') as HTMLInputElement).value).toBe('Bienvenida');
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(updateDraft).toHaveBeenCalledWith('id-1', expect.objectContaining({ version: 4 })));
  });

  it('cancelar a edição limpa o formulário', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-editar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-editar-ar_bienvenida'));
    await u.click(screen.getByTestId('td-cancelar'));
    expect((screen.getByTestId('td-input-name') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('td-cancelar')).toBeNull();
  });

  it('arquivar chama a API e recarrega', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-arquivar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-arquivar-ar_bienvenida'));
    await waitFor(() => expect(archiveDraft).toHaveBeenCalledWith('id-1'));
    expect(listDrafts).toHaveBeenCalledTimes(2);
  });

  it('arquivar o que está sendo editado limpa o formulário', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-editar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-editar-ar_bienvenida'));
    await u.click(screen.getByTestId('td-arquivar-ar_bienvenida'));
    await waitFor(() => expect((screen.getByTestId('td-input-name') as HTMLInputElement).value).toBe(''));
  });

  it('falha ao arquivar avisa em vez de sumir com a linha', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    archiveDraft.mockRejectedValue(new Error('nope'));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-arquivar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-arquivar-ar_bienvenida'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroArquivar'));
  });

  it('trocar idioma muda o prefixo previsto do slug', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await u.type(screen.getByTestId('td-input-slug'), 'boas_vindas');
    await u.selectOptions(screen.getByTestId('td-select-language'), 'pt-BR');
    expect(screen.getByTestId('td-slug-previsto').textContent).toContain('br_boas_vindas');
  });

  it('trocar categoria leva o valor escolhido no salvamento', async () => {
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await preencher(u);
    await u.selectOptions(screen.getByTestId('td-select-category'), 'MARKETING');
    await u.click(screen.getByTestId('td-salvar'));
    await waitFor(() => expect(createDraft.mock.calls[0][0].category).toBe('MARKETING'));
  });
});

describe('enviar para autorização — o ato irreversível', () => {
  const abrirConfirmacao = async (u: ReturnType<typeof userEvent.setup>) => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-enviar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-enviar-ar_bienvenida'));
  };

  it('a confirmação ENUMERA o que se torna irreversível — não é "tem certeza?"', async () => {
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    expect(screen.getByTestId('td-confirmar-lista').children).toHaveLength(3);
    const texto = screen.getByTestId('td-confirmar-lista').textContent ?? '';
    expect(texto).toContain('confirmar.nome');
    expect(texto).toContain('confirmar.edicao');
    expect(texto).toContain('confirmar.prazo');
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
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(submitDraft).toHaveBeenCalledWith('id-1'));
    await waitFor(() => expect(screen.getByTestId('td-salvo').textContent)
      .toContain('admin.templateDrafts.enviado'));
  });

  it('🔒 503 diz QUAL motivo — flag desligada ou credencial faltando', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('x', 503, 'submissao_indisponivel', [], null, 'flag_desligada'));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('indisponivel.flag_desligada'));
  });

  it('502 da Twilio vira mensagem nomeada, não erro cru', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('x', 502, 'twilio_falhou'));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('envioErro.twilio_falhou'));
  });

  it('422 no envio fecha a confirmação e mostra a regra no campo', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('x', 422, null, [{ campo: 'body', regra: 'placeholder_posicional' }]));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.queryByTestId('td-confirmar')).toBeNull());
    expect(screen.getByTestId('td-problemas-body').textContent).toContain('placeholder_posicional');
  });

  it('erro sem código cai na mensagem do servidor', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('caiu tudo', 500, null));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent).toContain('caiu tudo'));
  });

  it('erro que não é da API cai no texto genérico', async () => {
    submitDraft.mockRejectedValue(new Error('rede'));
    const u = userEvent.setup();
    await abrirConfirmacao(u);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroEnviar'));
  });
});

describe('depois de submetido', () => {
  const submetido = () => draft({ contentSid: 'HXja', submittedAt: '2026-08-31T20:00:00Z', status: 'submitted' });

  it('🔒 NÃO oferece editar nem enviar — só duplicar', async () => {
    listDrafts.mockResolvedValue({ drafts: [submetido()] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-duplicar-ar_bienvenida')).toBeTruthy());
    expect(screen.queryByTestId('td-editar-ar_bienvenida')).toBeNull();
    expect(screen.queryByTestId('td-enviar-ar_bienvenida')).toBeNull();
  });

  it('mostra o estado "enviado, aguardando" — não deixa a pessoa supor', async () => {
    listDrafts.mockResolvedValue({ drafts: [submetido()] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-estado-ar_bienvenida').textContent)
      .toContain('estado.submitted'));
  });

  it('rascunho não submetido diz que ainda não foi', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft()] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-estado-ar_bienvenida').textContent)
      .toContain('estado.draft'));
  });

  it('duplicar cria o clone e já o abre para edição', async () => {
    listDrafts.mockResolvedValue({ drafts: [submetido()] });
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-duplicar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-duplicar-ar_bienvenida'));
    await waitFor(() => expect(duplicateDraft).toHaveBeenCalledWith('id-1'));
    await waitFor(() => expect((screen.getByTestId('td-input-slug') as HTMLInputElement).value)
      .toBe('ar_bienvenida_v2'));
  });

  it('falha ao duplicar avisa', async () => {
    listDrafts.mockResolvedValue({ drafts: [submetido()] });
    duplicateDraft.mockRejectedValue(new Error('nope'));
    const u = userEvent.setup();
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-duplicar-ar_bienvenida')).toBeTruthy());
    await u.click(screen.getByTestId('td-duplicar-ar_bienvenida'));
    await waitFor(() => expect(screen.getByTestId('td-erro').textContent)
      .toContain('admin.templateDrafts.erroDuplicar'));
  });

  it('a última falha de envio aparece na linha, não fica escondida no banco', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({ submissionError: 'criar_content: 400 nome em uso' })] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-falha-ar_bienvenida').textContent)
      .toContain('400 nome em uso'));
  });

  it('lista as variáveis disponíveis — a pessoa não pode ter de adivinhar', async () => {
    render(<TemplateDraftsPage />);
    expect(screen.getByTestId('td-variaveis-ajuda').textContent).toContain('worker_name');
    expect(screen.getByTestId('td-variaveis-ajuda').textContent).toContain('case_number');
  });
});

describe('🔒 o veredito da META na lista — o bug de 01/09', () => {
  it('enviado e SEM resposta ainda diz "esperando"', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({
      contentSid: 'HXa', submittedAt: '2026-09-01T02:00:00Z', status: 'submitted',
    })] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-estado-ar_bienvenida').textContent)
      .toContain('estado.submitted'));
  });

  it('🔒 APROVADO mostra o veredito — antes ficava "esperando" PARA SEMPRE', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({
      contentSid: 'HXa', submittedAt: '2026-09-01T02:00:00Z',
      metaStatus: 'APPROVED', status: 'decided',
    })] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-estado-ar_bienvenida').textContent)
      .toContain('veredito.APPROVED'));
  });

  it('RECUSADO mostra o veredito E o motivo', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({
      contentSid: 'HXa', submittedAt: '2026-09-01T02:00:00Z',
      metaStatus: 'REJECTED', metaReason: 'INCORRECT_CATEGORY', status: 'decided',
    })] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-estado-ar_bienvenida').textContent)
      .toContain('veredito.REJECTED'));
    expect(screen.getByTestId('td-motivo-ar_bienvenida').textContent).toContain('INCORRECT_CATEGORY');
  });

  it('decidido também NÃO deixa editar — só duplicar', async () => {
    listDrafts.mockResolvedValue({ drafts: [draft({
      contentSid: 'HXa', submittedAt: '2026-09-01T02:00:00Z',
      metaStatus: 'APPROVED', status: 'decided',
    })] });
    render(<TemplateDraftsPage />);
    await waitFor(() => expect(screen.getByTestId('td-duplicar-ar_bienvenida')).toBeTruthy());
    expect(screen.queryByTestId('td-editar-ar_bienvenida')).toBeNull();
  });
});
