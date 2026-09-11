import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

/**
 * URL oficial do trâmite (Passo 0 da Fase 3, medido 2026-09-11:
 * `curl -sI` → 200). URL CONSTANTE, sem query string — condição C9 do lex
 * (`fatos-medidos.md` F15): "link 'Cómo sacarlo' = URL constante sem
 * query, `<a target="_blank" rel="noopener noreferrer">`, com teste de
 * `href`+`rel`". Se este link cair no futuro, o fallback é a URL alternativa
 * de `fase-3.md`; se as duas caírem, a ajuda perde o link, não o texto.
 */
export const ANTECEDENTES_HELP_URL =
  'https://www.argentina.gob.ar/justicia/reincidencia/antecedentespenales';

interface AntecedentesHelpExpandableProps {
  className?: string;
}

/**
 * Ajuda "¿No lo tenés? Cómo sacarlo" pro documento de antecedentes penais
 * (Fase 3 de postulacao-documento-pendente, DD4 · consome F12).
 *
 * UM componente, DOIS usos: no item `doc_criminal_record` da lista de
 * tarefas da home (`PendingTasksCard`) e no slot `criminal_record` da aba
 * Documentos (`DocumentsGrid`). Cada chamador decide QUANDO montar este
 * componente (antecedentes pendente + arquivo ainda não subido + país
 * Argentina) — ele mesmo não sabe de `missingFields` nem de país.
 *
 * SEM valor em pesos (DD4): o preço do trâmite muda sem aviso e a tela
 * mentiria. `grep -rnE "\$ ?[0-9]" .../locales/*.json | grep -i antecedente`
 * tem de continuar vazio.
 *
 * 🔒 Achado do gate (11/09): `color="muted"` do atom `Text` mapeia pra
 * `gray-700`, que na paleta desta casa (`tailwind.config.js`) é
 * `rgba(115, 115, 115, 0.5)` — um cinza com ALPHA, invisível no nome da
 * classe. Composto sobre fundo branco isso vira ~#B9B9B9, contraste
 * 1,96:1 (WCAG AA texto pequeno exige ≥ 4,5:1). Por isso `tertiary`
 * (`#374151`, 10,31:1) aqui — não `secondary` (mais claro, mas ainda
 * abaixo do peso visual que este texto de apoio pede).
 */
export function AntecedentesHelpExpandable({ className = '' }: AntecedentesHelpExpandableProps): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div data-testid="antecedentes-help" className={className}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex items-center gap-1 text-left"
      >
        <Text as="span" size="xs" weight="medium" color="tertiary" data-testid="antecedentes-help-toggle-text">
          {t('documents.antecedentesHelp.toggle')}
        </Text>
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-800 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div data-testid="antecedentes-help-body" className="mt-1 flex flex-col items-start gap-1">
          {/*
            Achado do gate (11/09, rodada 2): testid DIRETO no `<Text>`
            que carrega `color` — o `<div data-testid="antecedentes-help-body">`
            que envolve texto+link não tem cor própria; medir nele leria o
            preto herdado, não o cinza real deste parágrafo.
          */}
          <Text as="p" size="xs" color="tertiary" data-testid="antecedentes-help-body-text">
            {t('documents.antecedentesHelp.body')}
          </Text>
          <a
            href={ANTECEDENTES_HELP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline w-fit"
          >
            <Text as="span" size="xs" weight="medium" color="primary">
              {t('documents.antecedentesHelp.link')}
            </Text>
          </a>
        </div>
      )}
    </div>
  );
}
