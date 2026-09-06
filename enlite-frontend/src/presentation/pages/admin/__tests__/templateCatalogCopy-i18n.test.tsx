/**
 * O TEXTO que a pessoa lê no catálogo, com o i18n REAL — não com `t: k => k`.
 *
 * 🔒 POR QUE ESTE ARQUIVO EXISTE. Em 01/09 encurtei os rótulos da coluna de
 * idioma e os 935 testes existentes passaram sem piscar. Passar não era boa
 * notícia: significava que NENHUM deles olhava para esse texto. O dublê de
 * `useTranslation` nos testes de página devolve a chave, então ele nunca
 * poderia ter pego a diferença entre "No sirve para etapas: usa datos…" e
 * "Etapas: usa datos…". Copy sem teste é copy que muda sozinha.
 *
 * O que estes testes protegem:
 *
 * 1. **A chave guarda o MOTIVO, não o enquadramento.** As chaves diziam
 *    "No sirve para etapas: …" e os 21 primeiros caracteres se repetiam em
 *    TODA linha da coluna — e apareciam DE NOVO no drawer, logo abaixo do
 *    rótulo "Por qué no sirve para etapas". A mesma frase duas vezes na tela.
 * 2. **O drawer não some quando a Meta não explica.** `Campo` devolve null com
 *    valor vazio; o bloco desaparecia inteiro e ninguém ficava sabendo que a
 *    Meta não mandou detalhe.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { TemplateCatalogLanguageCell } from '../TemplateCatalogLanguageCell';
import { TemplateCatalogPage } from '../TemplateCatalogPage';
import { TemplateCatalogTimeline } from '../TemplateCatalogTimeline';
import { TemplateCatalogDetailFields } from '../TemplateCatalogDetailFields';
import { construirLinhaDoTempo } from '../templateCatalogHistorico';

/**
 * 🔒 O IDIOMA VOLTA EM `afterEach`, e isto é conserto de um vazamento real.
 *
 * O teste em pt-BR restaurava o idioma na ÚLTIMA linha do próprio corpo. Quando
 * ele falhou por outro motivo, a linha nunca rodou — e todos os testes
 * seguintes passaram a comparar texto espanhol contra a tradução portuguesa,
 * falhando por uma razão que não tinha nada a ver com o que mediam. Limpeza em
 * hook roda mesmo quando o teste morre no meio.
 */
afterEach(async () => {
  if (i18n.language !== 'es') await i18n.changeLanguage('es');
});

const getTemplateCatalog = vi.fn();
vi.mock('@infrastructure/http/AdminTemplateCatalogApiService', () => ({
  AdminTemplateCatalogApiService: { getTemplateCatalog: (...a: unknown[]) => getTemplateCatalog(...a) },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es', fallbackLng: 'es', interpolation: { escapeValue: false },
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
  });
});

const row = (over: Partial<TemplateCatalogRow> = {}): TemplateCatalogRow => ({
  slug: 'ar_x', name: 'ar_x', bodyTwilio: 'texto', category: 'MARKETING', isActive: true,
  contentSid: 'HX', metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT', metaDetail: null,
  metaCheckedAt: null, eligible: false, ineligibleReason: 'PLACEHOLDERS',
  placeholders: [], usedInStages: [],
  isDraft: false, language: 'es-AR', baseName: 'x', ...over,
});

const cell = (o: Partial<TemplateCatalogRow> = {}) => render(
  <MemoryRouter>
    <TemplateCatalogLanguageCell
      row={row(o)} language="es-AR" baseName="x"
      statusTone={() => ''} statusLabel={() => 'Rechazada'} onOpen={vi.fn()}
    />
  </MemoryRouter>,
);

/**
 * A copy de inelegibilidade mora na coluna "Mensaje" da PÁGINA — por isso este
 * helper renderiza a tela inteira, com a API dublada, em vez da célula.
 */
const lista = async (o: Partial<TemplateCatalogRow> = {}) => {
  getTemplateCatalog.mockResolvedValue({ templates: [row(o)] });
  render(<MemoryRouter><TemplateCatalogPage /></MemoryRouter>);
  await screen.findByTestId('tc-table');
};

/*
 * ⚠️ A INELEGIBILIDADE MUDOU DE COLUNA. Ela vivia na célula do idioma, onde a
 * frase quebrava em três linhas e inflava a altura de toda a linha da tabela. O
 * desenho a põe sob a mensagem — e a pergunta que ela responde ("esta MENSAGEM
 * serve para etapa?") é sobre a mensagem, não sobre o idioma. Por isso estes
 * testes agora renderizam a PÁGINA: é lá que a copy mora.
 */
describe('a inelegibilidade diz o motivo, não repete o significado da coluna', () => {
  it('🔒 inelegibilidade sai como "Etapas: <motivo>", sem a frase longa', async () => {
    await lista();
    const el = screen.getByTestId('tc-ineligible-x');
    expect(el).toHaveTextContent('Etapas: usa datos que el sistema no completa');
    // A frase que repetia em toda linha não volta.
    expect(el.textContent).not.toContain('No sirve para etapas');
  });

  it('🔒 o motivo da Meta perde o comentário sobre a AUSÊNCIA de detalhe', () => {
    cell();
    const el = screen.getByTestId('tc-reason-ar_x');
    expect(el).toHaveTextContent('Formato inválido');
    // Numa varredura interessa O QUE deu errado, não que não há mais o que dizer.
    expect(el.textContent).not.toContain('Meta no dio');
  });

  it('duas linhas em vez de corte: nada fica cortado no meio da palavra', async () => {
    await lista();
    // `truncate` (nowrap + ellipsis) cortava as frases de 58 e 70 caracteres.
    expect(screen.getByTestId('tc-ineligible-x').className).toContain('line-clamp-2');
    expect(screen.getByTestId('tc-ineligible-x').className).not.toContain('truncate');
  });

  it('em português o enquadramento também é curto', async () => {
    await i18n.changeLanguage('pt-BR');
    await lista();
    expect(screen.getByTestId('tc-ineligible-x')).toHaveTextContent('Etapas: usa dados que o sistema não preenche');
  });
});

describe('o drawer enquadra pelo RÓTULO, e não deixa buraco', () => {
  const drawer = (o: Partial<TemplateCatalogRow> = {}) => render(
    <MemoryRouter>
      <>
        {/* O drawer virou página (Tela 4). O que estas asserções mediam — a
            COPY do motivo, da explicação e da inelegibilidade — mudou de casa
            para estes dois componentes, e os `data-testid` foram preservados
            justamente para o teste continuar medindo a mesma coisa. */}
        <TemplateCatalogTimeline eventos={construirLinhaDoTempo(row(o), null)} row={row(o)} />
        <TemplateCatalogDetailFields row={row(o)} />
      </>
    </MemoryRouter>,
  );

  it('🔒 o rótulo diz "Por qué no sirve para etapas" e o valor NÃO repete isso', () => {
    drawer();
    const el = screen.getByTestId('tc-detalhe-inelegivel');
    expect(el).toHaveTextContent('usa datos que el sistema no completa');
    expect(el.textContent).not.toContain('No sirve para etapas');
    // O enquadramento vem do rótulo do campo, uma vez só.
    expect(screen.getByText('Por qué no sirve para etapas')).toBeInTheDocument();
  });

  it('🔒 sem explicação da Meta, o campo DIZ isso — antes ele sumia', () => {
    drawer({ metaDetail: null });
    expect(screen.getByTestId('tc-detalhe-sem-explicacao')).toHaveTextContent('Meta no dio más detalle');
  });

  it('com explicação, mostra a prosa da Meta e não o texto de ausência', () => {
    drawer({ metaDetail: 'Separá los parámetros con texto descriptivo.' });
    expect(screen.getByTestId('tc-detalhe-explicacao')).toHaveTextContent('Separá los parámetros');
    expect(screen.queryByTestId('tc-detalhe-sem-explicacao')).not.toBeInTheDocument();
  });
});
