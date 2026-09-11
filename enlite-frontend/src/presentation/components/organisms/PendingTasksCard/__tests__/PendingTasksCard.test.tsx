/**
 * PendingTasksCard.test.tsx
 *
 * Fase 2 de postulacao-documento-pendente (DD2/DD3): lista de tarefas que
 * substitui o `ProfileCompletionCard` na home. Renderiza com i18n REAL (es +
 * pt-BR) porque o que importa aqui é o TEXTO que a prestadora lê (voseo,
 * pluralização, nome de cada documento) — um mock `t: key => key` não prova
 * nada disso (mesmo padrão de `sex-both-i18n.test.tsx`).
 *
 * `missingFields` é SEMPRE o array vindo do servidor (Fase 1) — este
 * componente NUNCA recalcula completude local (F1/DD1).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { PendingTasksCard } from '../PendingTasksCard';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage('es');
});

describe('PendingTasksCard', () => {
  it('missingFields vazio → não renderiza nada (worker completo, sem lista)', () => {
    const { container } = render(<PendingTasksCard missingFields={[]} profession="CAREGIVER" />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('feliz — AT só sem antecedentes', () => {
    it('título "Te falta 1 paso para postularte" (singular)', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      expect(screen.getByText('Te falta 1 paso para postularte')).toBeInTheDocument();
    });

    it('linha "Antecedentes penales" visível, com botão "Subir ahora"', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      expect(screen.getByText('Antecedentes penales')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Subir ahora — Antecedentes penales/i }),
      ).toBeInTheDocument();
    });

    it('clicar no botão da linha navega pro slot destacado (?tab=documents&focus=criminal_record)', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      screen.getByRole('button', { name: /Subir ahora — Antecedentes penales/i }).click();
      expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=documents&focus=criminal_record');
    });

    it('"Ya completaste 6 de 7" — AT exige 4 docs + 3 passos de registro, só 1 pendência', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      expect(screen.getByText('Ya completaste 6 de 7')).toBeInTheDocument();
    });

    it('recolhido lista os 3 passos de registro + os 3 documentos já completos', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      const collapsed = screen.getByTestId('pending-tasks-completed');
      expect(collapsed).toHaveTextContent(
        'Información General · Dirección de Atención · Disponibilidad · Documento de identidad · Currículum vitae · Certificado de Acompañante Terapéutico',
      );
    });
  });

  describe('alt — dado geral e documento pendentes (dois grupos, ordem DD2)', () => {
    it('mostra a linha de registro ANTES da linha de documento', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record', 'phone']} profession="CAREGIVER" />);
      const rows = screen.getAllByText(/Información General|Antecedentes penales/);
      const texts = rows.map((el) => el.textContent);
      expect(texts.indexOf('Información General')).toBeLessThan(texts.indexOf('Antecedentes penales'));
    });

    it('título conta as DUAS pendências ("Te falta 2 pasos")', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record', 'phone']} profession="CAREGIVER" />);
      expect(screen.getByText('Te falta 2 pasos para postularte')).toBeInTheDocument();
    });

    it('botão da linha de registro diz "Completar", não "Subir ahora"', () => {
      render(<PendingTasksCard missingFields={['phone']} profession="CAREGIVER" />);
      expect(
        screen.getByRole('button', { name: /Completar — Información General/i }),
      ).toBeInTheDocument();
    });

    it('clicar no botão de registro navega SEM focus (aba inteira, vários campos podem faltar)', () => {
      render(<PendingTasksCard missingFields={['phone']} profession="CAREGIVER" />);
      screen.getByRole('button', { name: /Completar — Información General/i }).click();
      expect(mockNavigate).toHaveBeenCalledWith('/worker/profile?tab=general');
    });
  });

  describe('documentos na ordem da política F5, independente da ordem de missingFields', () => {
    it('CAREGIVER com os 2 docs pendentes em ordem invertida no array → linhas saem DNI antes de Antecedentes', () => {
      render(
        <PendingTasksCard
          missingFields={['doc_criminal_record', 'doc_identity_document']}
          profession="CAREGIVER"
        />,
      );
      const rows = screen.getAllByText(/Documento de identidad|Antecedentes penales/);
      const texts = rows.map((el) => el.textContent);
      expect(texts.indexOf('Documento de identidad')).toBeLessThan(texts.indexOf('Antecedentes penales'));
    });
  });

  describe('CUIDADOR/CAREGIVER — total Y não inclui docs de AT', () => {
    it('"Ya completaste 4 de 5" — Cuidador só exige DNI + antecedentes (F5), não CV nem certificado AT (Y = 3 registro + 2 docs)', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="CAREGIVER" />);
      expect(screen.getByText('Ya completaste 4 de 5')).toBeInTheDocument();
    });
  });

  describe('data-clarity-mask (condição C12 do lex)', () => {
    it('o contêiner das linhas tem data-clarity-mask="True"', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      expect(screen.getByTestId('pending-tasks-rows')).toHaveAttribute('data-clarity-mask', 'True');
    });
  });

  describe('pt-BR', () => {
    it('título em pt-BR usa "Falta 1 passo para você se candidatar"', () => {
      i18n.changeLanguage('pt-BR');
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      expect(screen.getByText('Falta 1 passo para você se candidatar')).toBeInTheDocument();
    });
  });
});
