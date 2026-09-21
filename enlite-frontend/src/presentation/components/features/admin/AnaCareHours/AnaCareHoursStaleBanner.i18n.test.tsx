/**
 * AnaCareHoursStaleBanner.i18n.test.tsx
 *
 * F2 (change `anacare-horas-conclusao-de-corrida`, migration 457) — "termina quando" do
 * design.md §F2: "Snapshot/teste de render das duas telas com os dois estados novos, i18n es e
 * pt-BR sem chave faltando (nenhum fallback de chave ausente visível na tela)."
 *
 * Diferença deliberada dos outros testes deste diretório: os outros MOCKAM `react-i18next` (o `t`
 * devolve a própria chave, o que é ótimo pra testar QUAL chave foi escolhida, mas NUNCA provaria
 * que a chave existe de verdade no JSON). Este arquivo usa o i18n REAL (mesmo padrão de
 * `sex-both-i18n.test.tsx`) com os JSONs `es`/`pt-BR` de verdade — se uma chave nova (`stale.
 * titleParcial`, `stale.messageDesconhecido`, etc.) faltar em qualquer um dos dois idiomas,
 * i18next devolve a CHAVE CRUA como texto, e o teste de "sem chave faltando" abaixo morre.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { AnaCareHoursListPage } from './AnaCareHoursListPage';
import { AnaCareHoursDetailPage } from './AnaCareHoursDetailPage';
import type { AnaCareMonthSnapshot, AnaCareHoursPatientSnapshot } from './types';
import type { AxonicoComprobanteService } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';

const AXONICO_SERVICE: AxonicoComprobanteService = { enviarComprobante: vi.fn() };
const PATIENT_DOCUMENT_SERVICE: AnaCarePatientDocumentService = { registerDocument: vi.fn() };

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// jsdom não implementa ResizeObserver — mesma necessidade de AnaCareHoursDetailPage.test.tsx.
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: false, // sem fallback: uma chave ausente no idioma ativo tem de aparecer CRUA, não silenciosamente em es.
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

function listSnapshot(overrides: Partial<AnaCareMonthSnapshot> = {}): AnaCareMonthSnapshot {
  return {
    month: '2026-09',
    updatedAt: '2026-09-15T08:00:00-03:00',
    stale: false,
    snapshotState: 'fresco',
    circuitBreakerOpen: false,
    patients: [],
    ...overrides,
  };
}

function detailSnapshot(overrides: Partial<AnaCareHoursPatientSnapshot> = {}): AnaCareHoursPatientSnapshot {
  return {
    month: '2026-09',
    updatedAt: '2026-09-15T08:00:00-03:00',
    stale: false,
    snapshotState: 'fresco',
    circuitBreakerOpen: false,
    patients: [{ anaCareId: 'PAT-1', linked: false, providers: [] }],
    ...overrides,
  };
}

/** Nenhuma chave i18n crua (`admin.anacareHours.stale....`) pode sobrar visível na tela — é o sinal de fallback de chave ausente. */
function expectNoRawStaleKey(container: HTMLElement): void {
  expect(container.textContent).not.toMatch(/admin\.anacareHours\.stale\./);
}

/**
 * O `AlertBanner` real (`organisms/Alert/AlertBanner.tsx`) renderiza `{title}:{' '}` num `<span>`
 * PRÓPRIO — o nó de texto de verdade é `"<título>: "` (com dois pontos e espaço), nunca o título
 * sozinho. `getByText(tituloExato)` por isso nunca casa; uma `RegExp` casa (mesmo padrão já usado
 * em `AnaCareHoursDetailPage.test.tsx` pra `titleNaoConstruido`) — `getNodeText` do
 * `@testing-library/dom` só olha os nós de TEXTO diretos de um elemento (nunca desce em elemento
 * filho), então o `<p>` ancestral (cujos únicos filhos são 2 `<span>`) nunca entra na disputa.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function titleMatcher(expected: string): RegExp {
  return new RegExp(escapeRegExp(expected));
}

describe.each([
  ['es', esJson.admin.anacareHours.stale],
  ['pt-BR', ptBRJson.admin.anacareHours.stale],
] as const)('AnaCareHours — banner de status em %s, i18n REAL (sem mock)', (locale, expectedStrings) => {
  beforeAll(async () => {
    await i18n.changeLanguage(locale);
  });

  afterAll(() => {
    cleanup();
  });

  it('LISTA — snapshotState=desconhecido: título/mensagem reais aparecem, nenhuma chave crua', () => {
    const { container } = render(
      <AnaCareHoursListPage snapshot={listSnapshot({ snapshotState: 'desconhecido' })} onOpenPatient={() => {}} />,
    );
    expect(screen.getByText(titleMatcher(expectedStrings.titleDesconhecido))).toBeInTheDocument();
    expect(screen.getByText(expectedStrings.messageDesconhecido)).toBeInTheDocument();
    expectNoRawStaleKey(container);
  });

  it('LISTA — snapshotState=parcial COM contagens: mensagem interpolada real (49 de 144), nenhuma chave crua', () => {
    const { container } = render(
      <AnaCareHoursListPage
        snapshot={listSnapshot({ snapshotState: 'parcial', reservationsTotal: 144, reservationsDone: 49 })}
        onOpenPatient={() => {}}
      />,
    );
    expect(screen.getByText(titleMatcher(expectedStrings.titleParcial))).toBeInTheDocument();
    const interpolada = expectedStrings.messageParcialComContagem.replace('{{done}}', '49').replace('{{total}}', '144');
    expect(screen.getByText(interpolada)).toBeInTheDocument();
    expectNoRawStaleKey(container);
  });

  it('DETALHE — snapshotState=parcial SEM contagens: mensagem curta real, nenhuma chave crua', () => {
    const { container } = render(
      <AnaCareHoursDetailPage
        axonicoService={AXONICO_SERVICE}
        patientDocumentService={PATIENT_DOCUMENT_SERVICE}
        snapshot={detailSnapshot({ snapshotState: 'parcial' })}
        patientId="PAT-1"
        onBack={() => {}}
      />,
    );
    expect(screen.getByText(titleMatcher(expectedStrings.titleParcial))).toBeInTheDocument();
    expect(screen.getByText(expectedStrings.messageParcial)).toBeInTheDocument();
    expectNoRawStaleKey(container);
  });

  it('DETALHE — snapshotState=desconhecido: título/mensagem reais, nenhuma chave crua', () => {
    const { container } = render(
      <AnaCareHoursDetailPage
        axonicoService={AXONICO_SERVICE}
        patientDocumentService={PATIENT_DOCUMENT_SERVICE}
        snapshot={detailSnapshot({ snapshotState: 'desconhecido' })}
        patientId="PAT-1"
        onBack={() => {}}
      />,
    );
    expect(screen.getByText(titleMatcher(expectedStrings.titleDesconhecido))).toBeInTheDocument();
    expect(screen.getByText(expectedStrings.messageDesconhecido)).toBeInTheDocument();
    expectNoRawStaleKey(container);
  });
});
