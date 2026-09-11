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
 *
 * BLOCKER 1 (gate 11/09): título (N) e "X de Y" tinham unidades diferentes —
 * N contava `missingFields.length` cru, Y usava um total fixo calculado com
 * `getRequiredDocSlugs` (que trata profissão NULL como CUIDADOR, divergindo
 * do portão SQL). O bloco "BLOCKER 1 — contagem" abaixo prova, caso a caso,
 * que agora N = linhas renderizadas e Y é derivado delas.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

// Importa pelo BARREL (index.ts), não pelo arquivo direto — BLOCKER 3 do
// gate (11/09): `PendingTasksCard/index.ts` aparecia com 0% de cobertura
// porque nenhum teste real passava por ele (WorkerHome.test.tsx mocka o
// componente pelo mesmo caminho de barrel). Mesmo caminho de import que
// `WorkerHome.tsx` usa em produção.
import { PendingTasksCard } from '..';

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

    it('título conta as DUAS pendências ("Te faltan 2 pasos")', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record', 'phone']} profession="CAREGIVER" />);
      expect(screen.getByText('Te faltan 2 pasos para postularte')).toBeInTheDocument();
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

  /**
   * BLOCKER 1 — contagem reproduzida pelo gate (11/09).
   *
   * O gate encontrou o bug com o script de diagnóstico
   * `.../scratchpad/vt/pending-count.test.tsx`, rodado contra o código
   * ANTIGO (pré-fix). Os valores "ANTES" citados nos comentários de cada
   * caso abaixo são os que aquele script logou (buggy); os asserts são os
   * valores CORRETOS pós-fix — cada um comprovado à mão contra a fórmula
   * (a)-(c) do gate e batido de volta contra o valor antigo.
   */
  describe('BLOCKER 1 — contagem: N (título) e Y ("X de Y") na MESMA unidade (linha renderizada)', () => {
    it('caso A: AT com phone + title_certificate (mesma aba) + doc_criminal_record → ANTES "Te falta 3 pasos"/2 linhas/"4 de 7" (unidades divergentes); AGORA "Te faltan 2 pasos", 2 linhas, "5 de 7"', () => {
      render(
        <PendingTasksCard
          missingFields={['phone', 'title_certificate', 'doc_criminal_record']}
          profession="AT"
        />,
      );
      expect(screen.getByText('Te faltan 2 pasos para postularte')).toBeInTheDocument();
      expect(screen.getByText('Ya completaste 5 de 7')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(2);
    });

    it('caso B: profession NULL com profession + doc_resume_cv + doc_at_certificate pendentes → ANTES "2 de 5" (NULL tratado como CUIDADOR); AGORA "4 de 7" (NULL tratado como AT, paridade com o portão)', () => {
      render(
        <PendingTasksCard
          missingFields={['profession', 'doc_resume_cv', 'doc_at_certificate']}
          profession={null}
        />,
      );
      expect(screen.getByText('Te faltan 3 pasos para postularte')).toBeInTheDocument();
      expect(screen.getByText('Ya completaste 4 de 7')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(3);
    });

    it('caso C: cadastro novo CAREGIVER (14 campos gerais + área + disponibilidade + 2 docs = 18 tokens crus, só 5 linhas) → ANTES título "Te falta 18 pasos" contra 5 botões na tela; AGORA "Te faltan 5 pasos"', () => {
      const generalTokens = [
        'first_name', 'last_name', 'sex', 'gender', 'birth_date', 'document_number',
        'phone', 'languages', 'profession', 'knowledge_level', 'title_certificate',
        'years_experience', 'experience_types', 'preferred_types',
      ];
      render(
        <PendingTasksCard
          missingFields={[
            ...generalTokens,
            'worker_service_areas',
            'worker_availability',
            'doc_identity_document',
            'doc_criminal_record',
          ]}
          profession="CAREGIVER"
        />,
      );
      expect(screen.getByText('Te faltan 5 pasos para postularte')).toBeInTheDocument();
      expect(screen.getByText('Ya completaste 0 de 5')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(5);
    });

    it('caso D: token cru "worker_documents" (fallback da Fase 1, expansão por documento indisponível) → UMA linha genérica "Documentos", NENHUM doc_* marcado como concluído', () => {
      render(<PendingTasksCard missingFields={['worker_documents']} profession="CAREGIVER" />);
      expect(screen.getByText('Te falta 1 paso para postularte')).toBeInTheDocument();
      expect(screen.getByText('Ya completaste 3 de 4')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(1);
      expect(screen.getAllByText('Documentos').length).toBeGreaterThan(0);
      // ANTES (bug): os 4 doc_* apareciam no recolhido como "concluídos" sem
      // saber qual documento realmente falta. AGORA: nenhum doc_* nomeado no
      // recolhido — só os 3 passos de registro (não pendentes aqui).
      const collapsed = screen.getByTestId('pending-tasks-completed');
      expect(collapsed).not.toHaveTextContent('Documento de identidad');
      expect(collapsed).not.toHaveTextContent('Antecedentes penales');
      expect(collapsed).not.toHaveTextContent('Currículum vitae');
      expect(collapsed).not.toHaveTextContent('Certificado de Acompañante Terapéutico');
    });

    it('2+ tokens na MESMA aba de registro colapsam em UMA linha — título usa a linha, não os tokens crus', () => {
      render(<PendingTasksCard missingFields={['phone', 'first_name']} profession="CAREGIVER" />);
      // ANTES (bug): pendingCount = missingFields.length = 2 → "Te falta 2 pasos" com 1 linha só na tela.
      expect(screen.getByText('Te falta 1 paso para postularte')).toBeInTheDocument();
      expect(screen.getByText('Ya completaste 4 de 5')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(1);
    });

    it('caso E: CAREGIVER com doc_resume_cv pendente (o servidor pede um doc que a política LOCAL de Cuidador não exige) → 1 linha "Currículum vitae", NÃO some da tela', () => {
      // Re-gate 11/09: `documentRows` (ramo não-genérico) fazia
      // `requiredDocTokens.filter((t) => documentsTokens.includes(t))` —
      // isso filtra a linha pela política LOCAL (requiredDocTypesFor), que
      // pra CAREGIVER só conhece identity_document/criminal_record. Um
      // doc_resume_cv pendente vindo do SERVIDOR (fn_worker_missing_fields,
      // fonte única, F1/DD1) desaparecia da tela: 0 linhas, "Te faltan 0
      // pasos", "5 de 5" — a home mentia que o cadastro estava completo.
      render(<PendingTasksCard missingFields={['doc_resume_cv']} profession="CAREGIVER" />);
      expect(screen.getByText('Te falta 1 paso para postularte')).toBeInTheDocument();
      expect(screen.getByText('Currículum vitae')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(1);
      // Y = linhas + concluídos, nunca um total fixo que ignora o extra do
      // servidor: 1 pendente (doc_resume_cv) + 5 concluídos (3 registro +
      // os 2 docs que a política de Cuidador conhece, DNI e antecedentes,
      // ambos ausentes de missingFields) = 6.
      expect(screen.getByText('Ya completaste 5 de 6')).toBeInTheDocument();
    });
  });

  describe('Fase 3 — ajuda "¿No lo tenés? Cómo sacarlo" (DD4, só no item doc_criminal_record)', () => {
    it('país AR + antecedentes pendente → mostra o toggle da ajuda, fechado por padrão', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" country="AR" />);
      expect(screen.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).toBeInTheDocument();
      expect(screen.queryByTestId('antecedentes-help-body')).not.toBeInTheDocument();
    });

    it('clicar no toggle abre o texto (sem preço) e o link "Cómo sacarlo" com href/target/rel corretos', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" country="AR" />);
      fireEvent.click(screen.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i }));

      expect(
        screen.getByText(
          'Se tramita online con Clave Fiscal o Mi Argentina y te llega por e-mail. Podés elegir recibirlo en 5 días hábiles o en 24 horas.',
        ),
      ).toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'Cómo sacarlo' });
      expect(link).toHaveAttribute(
        'href',
        'https://www.argentina.gob.ar/justicia/reincidencia/antecedentespenales',
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('país diferente de AR (trâmite é argentino) → NÃO mostra a ajuda, mesmo com antecedentes pendente', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" country="BR" />);
      expect(screen.queryByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).not.toBeInTheDocument();
    });

    it('país AR mas antecedentes NÃO pendente (só doc_resume_cv) → some a ajuda', () => {
      render(<PendingTasksCard missingFields={['doc_resume_cv']} profession="CAREGIVER" country="AR" />);
      expect(screen.queryByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).not.toBeInTheDocument();
    });

    it('token genérico worker_documents (não sabemos se é antecedentes) → some a ajuda mesmo em AR', () => {
      render(<PendingTasksCard missingFields={['worker_documents']} profession="CAREGIVER" country="AR" />);
      expect(screen.queryByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).not.toBeInTheDocument();
    });

    it('sem prop country (chamador não informou) → some a ajuda (fail-closed, não presume Argentina)', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" />);
      expect(screen.queryByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).not.toBeInTheDocument();
    });

    it('a contagem de linhas (pending-task-row) NÃO conta a ajuda — ela é parte da MESMA linha do antecedentes', () => {
      render(<PendingTasksCard missingFields={['doc_criminal_record']} profession="AT" country="AR" />);
      expect(screen.getAllByTestId('pending-task-row')).toHaveLength(1);
    });
  });
});
