/**
 * A tela de DETALHE de uma mensagem (spec 010, Tela 4 do desenho de 31/08).
 *
 * 🔒 A MAIOR PARTE DESTES TESTES NÃO É NOVA: eles vieram de
 * `TemplateCatalogPage.test.tsx`, onde mediam o drawer. O drawer virou rota, e o
 * comportamento não mudou — motivo, explicação, variáveis, uso, elegibilidade,
 * data e SID continuam sendo exatamente o que a tela tem de dizer. Testes que
 * seguem o comportamento em vez de morrerem com o componente são a diferença
 * entre migrar uma tela e reescrevê-la no escuro.
 *
 * O que É novo aqui: a linha do tempo, o card "qué podés hacer", o link para a
 * Twilio, e o caso de slug que não existe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TemplateCatalogDetailPage } from '../TemplateCatalogDetailPage';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { DraftApiError, type TemplateDraft } from '@infrastructure/http/AdminTemplateDraftsApiService';

const getTemplateCatalog = vi.fn();
const listDrafts = vi.fn();
const archiveDraft = vi.fn();
const submitDraft = vi.fn();
const duplicateDraft = vi.fn();
vi.mock('@infrastructure/http/AdminTemplateCatalogApiService', () => ({
  AdminTemplateCatalogApiService: { getTemplateCatalog: (...a: unknown[]) => getTemplateCatalog(...a) },
}));
/*
 * ⚠️ `orig` em vez de objeto solto: desde que as ações do rascunho vieram para
 * esta tela, o componente importa `DraftApiError` — uma CLASSE, testada com
 * `instanceof`. Um mock que não a devolvesse faria todo erro cair no ramo
 * genérico, e os testes de "503 diz qual motivo" passariam por engano.
 */
vi.mock('@infrastructure/http/AdminTemplateDraftsApiService', async (orig) => {
  const real = await orig<typeof import('@infrastructure/http/AdminTemplateDraftsApiService')>();
  return {
    ...real,
    AdminTemplateDraftsApiService: {
      listDrafts: (...a: unknown[]) => listDrafts(...a),
      archiveDraft: (...a: unknown[]) => archiveDraft(...a),
      submitDraft: (...a: unknown[]) => submitDraft(...a),
      duplicateDraft: (...a: unknown[]) => duplicateDraft(...a),
    },
  };
});

/** Mesmo dublê da tela do catálogo — `t(k, {count})` recebe OBJETO, não string. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, arg?: string | Record<string, unknown>) =>
      typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? `${k}:${JSON.stringify(arg)}` : k,
    i18n: { language: 'es' },
  }),
}));

const row = (over: Partial<TemplateCatalogRow> = {}): TemplateCatalogRow => ({
  slug: 'ar_bienvenida', name: 'ar_bienvenida', bodyTwilio: 'Hola María, bienvenida',
  language: 'es-AR', category: 'UTILITY', isActive: true, contentSid: 'HXaaa',
  metaStatus: 'APPROVED', metaReason: null, metaDetail: null,
  metaCheckedAt: '2026-08-31T12:00:00Z',
  eligible: true, ineligibleReason: null, placeholders: [], usedInStages: [],
  isDraft: false,
  ...over,
  baseName: over.baseName ?? over.slug ?? 'ar_bienvenida',
});

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  id: 'id-1', slug: 'ar_bienvenida', baseName: 'bienvenida', name: 'Bienvenida', body: 'Hola',
  category: 'UTILITY', language: 'es-AR', version: 1,
  createdBy: 'ana', updatedBy: 'ana',
  createdAt: '2026-05-18T14:04:00Z', updatedAt: '2026-05-18T14:04:00Z',
  contentSid: null, submittedAt: null, submittedBy: null, submissionError: null,
  metaStatus: null, metaReason: null, metaDetail: null, metaCheckedAt: null,
  status: 'draft', ...over,
});

/**
 * Onde a navegação PAROU. Sem isto, "duplicar leva ao compositor" só poderia ser
 * afirmado pelo mock do serviço — e o mock diria "chamei a API", não "a pessoa
 * chegou onde precisava". A rota de destino imprime o endereço.
 */
function Destino(): JSX.Element {
  const { search } = useLocation();
  return <div data-testid="destino">{search}</div>;
}

const abrir = async (templates: TemplateCatalogRow[], slug = 'ar_bienvenida', drafts: TemplateDraft[] = []) => {
  getTemplateCatalog.mockResolvedValue({ templates });
  listDrafts.mockResolvedValue({ drafts });
  render(
    <MemoryRouter initialEntries={[`/admin/plantillas/${slug}`]}>
      <Routes>
        <Route path="/admin/plantillas/:slug" element={<TemplateCatalogDetailPage />} />
        <Route path="/admin/plantillas/registrar" element={<Destino />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(getTemplateCatalog).toHaveBeenCalled());
};

describe('o cabeçalho — o TEXTO é o título', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mostra o TEXTO aprovado, que é o que a pessoa veio ver', async () => {
    await abrir([row({ bodyTwilio: 'Hola, todo bien por acá' })]);
    expect((await screen.findByTestId('tc-detalhe-texto')).textContent).toContain('todo bien por acá');
  });

  it('sem texto sincronizado avisa, em vez de painel vazio', async () => {
    await abrir([row({ bodyTwilio: null })]);
    expect((await screen.findByTestId('tc-detalhe-texto')).textContent).toContain('noText');
  });

  it('o estado da Meta aparece no selo do cabeçalho', async () => {
    await abrir([row({ metaStatus: 'REJECTED' })]);
    // O dublê de `t` devolve o FALLBACK quando ele é string — e o fallback aqui
    // é o próprio código. O que este teste garante é que o selo mostra o estado,
    // não que a chave existe (isso é do teste de i18n real).
    expect((await screen.findByTestId('tc-detalhe-status')).textContent).toContain('REJECTED');
  });

  it('nunca verificado NÃO vira "pendente"', async () => {
    await abrir([row({ metaStatus: null })]);
    const s = (await screen.findByTestId('tc-detalhe-status')).textContent ?? '';
    expect(s).toContain('neverChecked');
    expect(s).not.toContain('PENDING');
  });
});

describe('a linha do tempo — só o que realmente sabemos', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mensagem que nasceu no painel tem os três marcos', async () => {
    await abrir(
      [row({ metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT', metaCheckedAt: '2026-05-19T12:34:00Z' })],
      'ar_bienvenida',
      [draft({ submittedAt: '2026-05-19T12:20:00Z', submittedBy: 'ana', status: 'submitted' })],
    );
    await screen.findByTestId('tc-detalhe-timeline');
    expect(screen.getByTestId('tc-detalhe-evento-criado')).toBeTruthy();
    expect(screen.getByTestId('tc-detalhe-evento-enviado')).toBeTruthy();
    expect(screen.getByTestId('tc-detalhe-evento-recusado')).toBeTruthy();
  });

  /**
   * 🔒 O CASO DE 26 DAS 28 LINHAS DE PRODUÇÃO. Elas vieram do Console da Twilio
   * e não têm rascunho: não existe "borrador creado" nem autor. A tela mostra
   * só o veredito — inventar os outros dois marcos seria afirmar uma autoria
   * que ninguém registrou.
   */
  it('mensagem vinda do sync mostra SÓ o veredito — não inventa autoria', async () => {
    await abrir([row({ metaStatus: 'APPROVED' })]);
    await screen.findByTestId('tc-detalhe-timeline');
    expect(screen.queryByTestId('tc-detalhe-evento-criado')).toBeNull();
    expect(screen.getByTestId('tc-detalhe-evento-aprovado')).toBeTruthy();
  });

  it('sem veredito e sem rascunho, DIZ que não há histórico — não fica vazio', async () => {
    await abrir([row({ metaStatus: null })]);
    expect(await screen.findByTestId('tc-detalhe-sem-historico')).toBeTruthy();
    expect(screen.queryByTestId('tc-detalhe-timeline')).toBeNull();
  });

  /**
   * 🔒 PAUSADA NÃO É RECUSADA. Recusada nunca esteve no ar; pausada ESTAVA e a
   * Meta desligou por denúncia de quem recebeu. Se caíssem no mesmo marco, a
   * tela ofereceria "corrigir o texto" para um problema que não é de texto.
   */
  it('pausada tem marco PRÓPRIO, não cai em "recusada"', async () => {
    await abrir([row({ metaStatus: 'PAUSED' })]);
    await screen.findByTestId('tc-detalhe-timeline');
    expect(screen.getByTestId('tc-detalhe-evento-pausado')).toBeTruthy();
    expect(screen.queryByTestId('tc-detalhe-evento-recusado')).toBeNull();
  });

  it('mostra quanto a Meta demorou — 14 min e três dias contam histórias diferentes', async () => {
    await abrir(
      [row({ metaStatus: 'REJECTED', metaCheckedAt: '2026-05-19T12:34:00Z' })],
      'ar_bienvenida',
      [draft({ submittedAt: '2026-05-19T12:20:00Z', status: 'submitted' })],
    );
    const txt = (await screen.findByTestId('tc-detalhe-demora')).textContent ?? '';
    expect(txt).toContain('depois.min');
    expect(txt).toContain('14');
  });

  /**
   * 🔒 O DEFEITO QUE A FOTO PEGOU E 961 TESTES NÃO. A versão anterior devolvia
   * sempre minutos, e a tela dizia «149892 min después» para uma mensagem
   * enviada em maio e verificada em agosto. O número estava certo e não
   * significava nada — que é o modo de falha desta classe: a asserção sobre "o
   * valor está lá" passa, e a tela continua ilegível.
   */
  it('🔒 três meses NÃO viram "149892 min" — a unidade acompanha o tamanho', async () => {
    await abrir(
      [row({ metaStatus: 'REJECTED', metaCheckedAt: '2026-08-31T12:00:00Z' })],
      'ar_bienvenida',
      [draft({ submittedAt: '2026-05-19T12:20:00Z', status: 'submitted' })],
    );
    const txt = (await screen.findByTestId('tc-detalhe-demora')).textContent ?? '';
    expect(txt).toContain('depois.d');
    expect(txt).not.toContain('149892');
  });

  it('algumas horas viram horas, não 180 minutos', async () => {
    await abrir(
      [row({ metaStatus: 'REJECTED', metaCheckedAt: '2026-05-19T15:20:00Z' })],
      'ar_bienvenida',
      [draft({ submittedAt: '2026-05-19T12:20:00Z', status: 'submitted' })],
    );
    expect((await screen.findByTestId('tc-detalhe-demora')).textContent).toContain('depois.h');
  });

  it('sem envio registrado NÃO mostra demora — "0 min" ali seria falso', async () => {
    await abrir([row({ metaStatus: 'REJECTED' })]);
    await screen.findByTestId('tc-detalhe-timeline');
    expect(screen.queryByTestId('tc-detalhe-demora')).toBeNull();
  });
});

describe('a citação da Meta', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('recusada: mostra o motivo E a explicação em prosa da Meta', async () => {
    await abrir([row({
      metaStatus: 'REJECTED', metaReason: 'INCORRECT_CATEGORY',
      metaDetail: 'La categoría no coincide con el contenido.',
    })]);
    expect((await screen.findByTestId('tc-detalhe-motivo')).textContent).toContain('INCORRECT_CATEGORY');
    expect(screen.getByTestId('tc-detalhe-explicacao').textContent).toContain('no coincide');
  });

  it('o código cru aparece, e marcado como vindo da Meta sem edição', async () => {
    await abrir([row({ metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT' })]);
    const cru = (await screen.findByTestId('tc-detalhe-motivo-cru')).textContent ?? '';
    expect(cru).toContain('INVALID_FORMAT');
    expect(cru).toContain('veioDaMeta');
  });

  it('🔒 quando a Meta não explica, a tela DIZ isso — não some o campo', async () => {
    await abrir([row({ metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT', metaDetail: null })]);
    expect((await screen.findByTestId('tc-detalhe-sem-explicacao')).textContent).toContain('metaSinDetalle');
  });

  it('aprovada: nem motivo nem explicação aparecem — não há o que dizer', async () => {
    await abrir([row({ metaStatus: 'APPROVED' })]);
    await screen.findByTestId('tc-detalhe-timeline');
    expect(screen.queryByTestId('tc-detalhe-motivo')).toBeNull();
    expect(screen.queryByTestId('tc-detalhe-explicacao')).toBeNull();
  });
});

describe('os campos de detalhe — vieram do drawer e continuam valendo', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('variável POSICIONAL ganha a explicação de posicional', async () => {
    await abrir([row({ placeholders: ['1', '2'] })]);
    expect((await screen.findByTestId('tc-detalhe-vars')).textContent).toContain('{{1}}');
    expect(screen.getByTestId('tc-detalhe-vars-posicionais').textContent).toContain('variaveisPosicionais');
  });

  it('variável NOMEADA ganha a explicação certa, não a de posicional', async () => {
    await abrir([row({ placeholders: ['worker_name'] })]);
    expect(await screen.findByTestId('tc-detalhe-vars-nomeadas')).toBeTruthy();
    expect(screen.queryByTestId('tc-detalhe-vars-posicionais')).toBeNull();
  });

  it('sem variáveis DIZ que é texto fixo, não deixa em branco', async () => {
    await abrir([row({ placeholders: [] })]);
    expect((await screen.findByTestId('tc-detalhe-vars-nenhuma')).textContent).toContain('semVariaveis');
  });

  it('mostra as etapas em que a mensagem é usada', async () => {
    await abrir([row({ usedInStages: ['SELECTED'] })]);
    expect((await screen.findByTestId('tc-detalhe-etapas')).textContent).toContain('SELECTED');
  });

  it('sem uso, diz que não é usada — não deixa em branco', async () => {
    await abrir([row({ usedInStages: [] })]);
    expect((await screen.findByTestId('tc-detalhe-etapas')).textContent).toContain('unused');
  });

  it('inelegível: explica por que não serve para etapas', async () => {
    await abrir([row({ eligible: false, ineligibleReason: 'PLACEHOLDERS' })]);
    expect((await screen.findByTestId('tc-detalhe-inelegivel')).textContent).toContain('ineligible');
  });

  it('elegível não mostra o bloco de "por que não serve"', async () => {
    await abrir([row({ eligible: true })]);
    await screen.findByTestId('tc-detalhe-campos');
    expect(screen.queryByTestId('tc-detalhe-inelegivel')).toBeNull();
  });

  it('nunca verificado diz "nunca", não data vazia', async () => {
    await abrir([row({ metaCheckedAt: null })]);
    expect((await screen.findByTestId('tc-detalhe-verificado')).textContent).toContain('never');
  });

  it('a data aparece formatada, não ISO cru', async () => {
    await abrir([row({ metaCheckedAt: '2026-08-31T12:00:00Z' })]);
    const txt = (await screen.findByTestId('tc-detalhe-verificado')).textContent ?? '';
    expect(txt).not.toContain('2026-08-31T12:00:00Z');
    expect(txt).toMatch(/31\/08\/2026/);
  });

  it('sem content_sid mostra travessão, não "null"', async () => {
    await abrir([row({ contentSid: null })]);
    expect((await screen.findByTestId('tc-detalhe-sid')).textContent).toBe('—');
  });
});

describe('o que dá para fazer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('"duplicar y corregir" leva base, idioma E o texto para o rascunho novo', async () => {
    await abrir([row({ bodyTwilio: 'Recordá completar tu registro', language: 'es-AR', baseName: 'registro' })]);
    const href = (await screen.findByTestId('tc-detalhe-duplicar')).getAttribute('href') ?? '';
    expect(href).toContain('base=registro');
    expect(href).toContain('lang=es-AR');
    // 🔒 Sem o texto, "corrigir" obrigaria a redigitar de cabeça o que está na
    // tela ao lado — e aí a correção vira outra mensagem.
    expect(decodeURIComponent(href)).toContain('Recordá completar tu registro');
  });

  it('o link para a Twilio usa o content_sid', async () => {
    await abrir([row({ contentSid: 'HXabc123' })]);
    expect((await screen.findByTestId('tc-detalhe-twilio')).getAttribute('href')).toContain('HXabc123');
  });

  /** Link que leva a erro faz quem clica achar que o sistema quebrou. */
  it('🔒 sem content_sid o link para a Twilio SOME, não vira link morto', async () => {
    await abrir([row({ contentSid: null })]);
    await screen.findByTestId('tc-detalhe-campos');
    expect(screen.queryByTestId('tc-detalhe-twilio')).toBeNull();
  });

  it('oferece criar a versão que falta quando o par está incompleto', async () => {
    await abrir([row({ slug: 'ar_x', baseName: 'x', language: 'es-AR' })], 'ar_x');
    const href = (await screen.findByTestId('tc-detalhe-criar-pt-BR')).getAttribute('href') ?? '';
    expect(href).toContain('base=x');
    expect(href).toContain('lang=pt-BR');
  });

  it('🔒 par COMPLETO não oferece ação nenhuma — botão morto é ruído', async () => {
    await abrir([
      row({ slug: 'ar_x', baseName: 'x', language: 'es-AR' }),
      row({ slug: 'br_x', baseName: 'x', language: 'pt-BR' }),
    ], 'ar_x');
    await screen.findByTestId('tc-detalhe-campos');
    expect(screen.queryByTestId('tc-detalhe-criar-pt-BR')).toBeNull();
    expect(screen.queryByTestId('tc-detalhe-criar-es-AR')).toBeNull();
  });
});

describe('os caminhos que não são o feliz', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /**
   * 🔒 "Não existe" é RESPOSTA, não erro. O sync apaga de `message_templates` o
   * que saiu da Twilio, então um link colado ontem pode não achar nada hoje —
   * e a tela precisa dizer isso com o slug na frente.
   */
  it('slug que não existe diz que não encontrou, com o slug', async () => {
    await abrir([row({ slug: 'ar_outra' })], 'ar_inexistente');
    const txt = (await screen.findByTestId('tcd-nao-encontrada')).textContent ?? '';
    expect(txt).toContain('naoEncontrada');
    expect(txt).toContain('ar_inexistente');
  });

  it('falha de carga mostra o erro, não a tela vazia', async () => {
    getTemplateCatalog.mockRejectedValue(new Error('boom'));
    listDrafts.mockResolvedValue({ drafts: [] });
    render(
      <MemoryRouter initialEntries={['/admin/plantillas/ar_x']}>
        <Routes><Route path="/admin/plantillas/:slug" element={<TemplateCatalogDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('tcd-erro')).textContent).toContain('boom');
    expect(screen.queryByTestId('tcd-nao-encontrada')).toBeNull();
  });

  /**
   * 🔒 A LISTA DE RASCUNHOS É OPCIONAL. 26 das 28 mensagens não têm rascunho
   * nenhum; derrubar a página inteira porque esse endpoint falhou esconderia o
   * que o catálogo já respondeu.
   */
  it('rascunhos indisponíveis NÃO derrubam a página', async () => {
    getTemplateCatalog.mockResolvedValue({ templates: [row()] });
    listDrafts.mockRejectedValue(new Error('503'));
    render(
      <MemoryRouter initialEntries={['/admin/plantillas/ar_bienvenida']}>
        <Routes><Route path="/admin/plantillas/:slug" element={<TemplateCatalogDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('tc-detalhe-texto')).toBeTruthy();
    expect(screen.queryByTestId('tcd-erro')).toBeNull();
  });
});

/**
 * AS AÇÕES DE UM RASCUNHO — o bloco que mudou de tela.
 *
 * 🔒 ESTES TESTES VIERAM DE `TemplateDraftsPage.test.tsx`, onde mediam a lista
 * "Borradores guardados" no pé do compositor. A lista saiu (não está na maquete,
 * e existia só porque o catálogo não mostrava rascunhos); as quatro ações vieram
 * para cá. O comportamento não mudou — editar, enviar, duplicar, arquivar, o
 * estado de cada um e a última falha de envio continuam sendo exatamente o que
 * o sistema tem de oferecer. Testes que seguem o comportamento em vez de
 * morrerem com o componente são a diferença entre migrar uma tela e reescrevê-la
 * no escuro. Foi o mesmo caminho de quando o drawer virou rota.
 */
describe('as ações de um rascunho', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archiveDraft.mockResolvedValue(undefined);
    submitDraft.mockResolvedValue({ submission: { contentSid: 'HXa', slug: 'ar_bienvenida' } });
    duplicateDraft.mockResolvedValue({ draft: draft({ id: 'id-2', slug: 'ar_bienvenida_v2', baseName: 'bienvenida_v2' }) });
  });

  const submetido = () => draft({ contentSid: 'HXja', submittedAt: '2026-08-31T20:00:00Z', status: 'submitted' });

  it('sem rascunho, o card não existe — e o "duplicar y corregir" do catálogo fica', async () => {
    await abrir([row()]);
    expect(await screen.findByTestId('tc-detalhe-duplicar')).toBeTruthy();
    expect(screen.queryByTestId('tc-detalhe-rascunho')).toBeNull();
  });

  it('rascunho gravado oferece editar, enviar e arquivar', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    expect(await screen.findByTestId('tc-rascunho-editar')).toBeTruthy();
    expect(screen.getByTestId('tc-rascunho-enviar')).toBeTruthy();
    expect(screen.getByTestId('tc-rascunho-arquivar')).toBeTruthy();
  });

  it('o "editar" aponta para o compositor COM O ID — nunca pela base', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    /*
     * 🔒 `?draft=id-1`, e não `?base=bienvenida`. A base também chega pelo
     * "duplicar y corregir", que quer um rascunho NOVO; se o compositor
     * adivinhasse a edição pela base, a correção sobrescreveria o original.
     */
    expect((await screen.findByTestId('tc-rascunho-editar')).getAttribute('href'))
      .toContain('draft=id-1');
  });

  it('🔒 dois "duplicar" com efeitos diferentes NÃO coexistem', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [submetido()]);
    // O do card clona a linha do banco; o do catálogo abre um rascunho novo com
    // o texto da Twilio. Mesmo nome, efeitos distintos: só um pode estar na tela.
    expect(await screen.findByTestId('tc-rascunho-duplicar')).toBeTruthy();
    expect(screen.queryByTestId('tc-detalhe-duplicar')).toBeNull();
  });

  it('🔒 submetido NÃO oferece editar nem enviar — só duplicar', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [submetido()]);
    expect(await screen.findByTestId('tc-rascunho-duplicar')).toBeTruthy();
    expect(screen.queryByTestId('tc-rascunho-editar')).toBeNull();
    expect(screen.queryByTestId('tc-rascunho-enviar')).toBeNull();
  });

  it('decidido também NÃO deixa editar', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [
      draft({ status: 'decided', metaStatus: 'APPROVED', contentSid: 'HXa' }),
    ]);
    expect(await screen.findByTestId('tc-rascunho-duplicar')).toBeTruthy();
    expect(screen.queryByTestId('tc-rascunho-editar')).toBeNull();
  });

  it('rascunho não submetido diz que ainda não foi', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    expect((await screen.findByTestId('tc-rascunho-estado')).textContent).toContain('estado.draft');
  });

  it('enviado e sem resposta diz "esperando" — não deixa a pessoa supor', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [submetido()]);
    expect((await screen.findByTestId('tc-rascunho-estado')).textContent).toContain('estado.submitted');
  });

  it('🔒 APROVADO mostra o veredito — antes ficava "esperando" PARA SEMPRE', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [
      draft({ status: 'decided', metaStatus: 'APPROVED', contentSid: 'HXa' }),
    ]);
    // O dublê de `t` devolve o fallback quando ele é string, e o fallback aqui
    // é o próprio código — o que se prova é que o VEREDITO chega, não a chave.
    expect((await screen.findByTestId('tc-rascunho-estado')).textContent).toContain('APPROVED');
  });

  it('RECUSADO mostra o veredito E o motivo', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [
      draft({ status: 'decided', metaStatus: 'REJECTED', metaReason: 'INCORRECT_CATEGORY', contentSid: 'HXa' }),
    ]);
    expect((await screen.findByTestId('tc-rascunho-estado')).textContent).toContain('REJECTED');
    expect(screen.getByTestId('tc-rascunho-motivo').textContent).toContain('INCORRECT_CATEGORY');
  });

  it('a última falha de envio aparece, não fica escondida no banco', async () => {
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [
      draft({ submissionError: 'criar_content: 400 nome em uso' }),
    ]);
    expect((await screen.findByTestId('tc-rascunho-falha')).textContent).toContain('400 nome em uso');
  });

  it('🔒 enviar NUNCA dispara direto — o clique só abre a confirmação', async () => {
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    await u.click(await screen.findByTestId('tc-rascunho-enviar'));
    expect(screen.getByTestId('td-confirmar')).toBeTruthy();
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it('sem marcar "li o texto", o botão está travado e o clique NÃO envia', async () => {
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    await u.click(await screen.findByTestId('tc-rascunho-enviar'));
    expect((screen.getByTestId('td-confirmar-sim') as HTMLButtonElement).disabled).toBe(true);
    await u.click(screen.getByTestId('td-confirmar-sim'));
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it('confirmar envia e recarrega a página', async () => {
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    await u.click(await screen.findByTestId('tc-rascunho-enviar'));
    await u.click(screen.getByTestId('td-confirmar-li'));
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(submitDraft).toHaveBeenCalledWith('id-1'));
    await waitFor(() => expect(getTemplateCatalog).toHaveBeenCalledTimes(2));
  });

  it('🔒 503 no envio diz QUAL motivo — flag desligada ou credencial faltando', async () => {
    submitDraft.mockRejectedValue(new DraftApiError('off', 503, null, [], null, 'flag_desligada'));
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    await u.click(await screen.findByTestId('tc-rascunho-enviar'));
    await u.click(screen.getByTestId('td-confirmar-li'));
    await u.click(screen.getByTestId('td-confirmar-sim'));
    await waitFor(() => expect(screen.getByTestId('tc-rascunho-erro').textContent)
      .toContain('indisponivel.flag_desligada'));
  });

  it('arquivar chama a API e recarrega', async () => {
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    await u.click(await screen.findByTestId('tc-rascunho-arquivar'));
    await waitFor(() => expect(archiveDraft).toHaveBeenCalledWith('id-1'));
    await waitFor(() => expect(getTemplateCatalog).toHaveBeenCalledTimes(2));
  });

  it('falha ao arquivar avisa em vez de sumir com a linha', async () => {
    archiveDraft.mockRejectedValue(new Error('nope'));
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [draft()]);
    await u.click(await screen.findByTestId('tc-rascunho-arquivar'));
    await waitFor(() => expect(screen.getByTestId('tc-rascunho-erro').textContent)
      .toContain('erroArquivar'));
  });

  it('duplicar cria o clone e LEVA ao compositor com ele aberto', async () => {
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [submetido()]);
    await u.click(await screen.findByTestId('tc-rascunho-duplicar'));
    await waitFor(() => expect(duplicateDraft).toHaveBeenCalledWith('id-1'));
    // Duplicar e ficar na mesma tela deixaria um rascunho novo em algum lugar
    // e nenhuma indicação de onde — o ato só termina onde dá para corrigir.
    await waitFor(() => expect(screen.getByTestId('destino').textContent).toContain('draft=id-2'));
  });

  it('falha ao duplicar avisa', async () => {
    duplicateDraft.mockRejectedValue(new Error('nope'));
    const u = userEvent.setup();
    await abrir([row({ isDraft: true })], 'ar_bienvenida', [submetido()]);
    await u.click(await screen.findByTestId('tc-rascunho-duplicar'));
    await waitFor(() => expect(screen.getByTestId('tc-rascunho-erro').textContent)
      .toContain('erroDuplicar'));
  });
});
