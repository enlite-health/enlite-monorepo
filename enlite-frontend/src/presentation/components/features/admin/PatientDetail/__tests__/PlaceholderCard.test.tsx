/**
 * PlaceholderCard — spec 014 US-D2 (decisão do Gabriel 03/09, item 9): cards inteiramente vazios
 * (Supervisión, Relatórios, Encuadre, Proyecto Terapéutico) viram "título + Próximamente REAL"
 * — nada de rótulo fantasma, botão disabled ou busca decorativa.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { PlaceholderCard } from '../PlaceholderCard';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

describe('PlaceholderCard', () => {
  it('mostra o título traduzido e "Próximamente" — nenhum botão, campo ou busca', () => {
    render(<PlaceholderCard titleKey="admin.patients.detail.supervisionCard.title" testId="supervisao-card" />);
    expect(screen.getByText('Supervisión')).toBeInTheDocument();
    expect(screen.getByText('Próximamente')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('aplica o testId recebido', () => {
    render(<PlaceholderCard titleKey="admin.patients.detail.matchingCard.title" testId="enquadre-terapeutico-card" />);
    expect(screen.getByTestId('enquadre-terapeutico-card')).toBeInTheDocument();
  });
});
