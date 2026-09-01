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
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { TemplateCatalogLanguageCell } from '../TemplateCatalogLanguageCell';
import { TemplateCatalogDetailDrawer } from '../TemplateCatalogDetailDrawer';

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
  placeholders: [], usedInStages: [], language: 'es-AR', baseName: 'x', ...over,
});

const cell = (o: Partial<TemplateCatalogRow> = {}) => render(
  <MemoryRouter>
    <TemplateCatalogLanguageCell
      row={row(o)} language="es-AR" baseName="x"
      statusTone={() => ''} statusLabel={() => 'Rechazada'} onOpen={vi.fn()}
    />
  </MemoryRouter>,
);

describe('a coluna de idioma diz o motivo, não repete o significado da coluna', () => {
  it('🔒 inelegibilidade sai como "Etapas: <motivo>", sem a frase longa', () => {
    cell();
    const el = screen.getByTestId('tc-ineligible-ar_x');
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

  it('duas linhas em vez de corte: nada fica cortado no meio da palavra', () => {
    cell();
    // `truncate` (nowrap + ellipsis) cortava as frases de 58 e 70 caracteres.
    expect(screen.getByTestId('tc-ineligible-ar_x').className).toContain('line-clamp-2');
    expect(screen.getByTestId('tc-ineligible-ar_x').className).not.toContain('truncate');
  });

  it('em português o enquadramento também é curto', async () => {
    await i18n.changeLanguage('pt-BR');
    cell();
    expect(screen.getByTestId('tc-ineligible-ar_x')).toHaveTextContent('Etapas: usa dados que o sistema não preenche');
    await i18n.changeLanguage('es');
  });
});

describe('o drawer enquadra pelo RÓTULO, e não deixa buraco', () => {
  const drawer = (o: Partial<TemplateCatalogRow> = {}) => render(
    <MemoryRouter>
      <TemplateCatalogDetailDrawer row={row(o)} statusLabel={() => 'Rechazada'} onClose={vi.fn()} />
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
