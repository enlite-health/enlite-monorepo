import { useTranslation } from 'react-i18next';
import { CircleCheck, ArrowRight } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientCompleteness, PatientCompletenessCode } from '@domain/entities/PatientDetail';

interface CompletenessChecklistProps {
  completeness: PatientCompleteness;
  /** Chamado ao clicar num item — a página troca de aba e pede o auto-open do drawer certo. */
  onFocusItem: (code: PatientCompletenessCode) => void;
}

type TranslateChecklist = (key: string, opts?: { defaultValue?: string; item?: string }) => string;

/** Uma pílula clicável — usada tanto na lista de bloqueio quanto na de pendências. */
function ChecklistItemButton({
  code,
  tc,
  onFocusItem,
  testId,
  tone,
}: {
  code: PatientCompletenessCode;
  tc: TranslateChecklist;
  onFocusItem: (code: PatientCompletenessCode) => void;
  testId: string;
  tone: 'blocking' | 'pending';
}) {
  const label = tc(`items.${code}`, { defaultValue: code });
  const toneClass =
    tone === 'blocking'
      ? 'border-amber-400 text-amber-800 hover:bg-amber-100'
      : 'border-gray-300 text-gray-700 hover:bg-gray-100';
  return (
    <button
      type="button"
      onClick={() => onFocusItem(code)}
      aria-label={tc('itemLinkAria', { item: label })}
      data-testid={testId}
      className={`flex items-center gap-1 bg-white border rounded-full px-3 py-1.5 transition-colors ${toneClass}`}
    >
      <Text as="span" size="sm" weight="medium" color="inherit">
        {label}
      </Text>
      <ArrowRight className="w-3.5 h-3.5" />
    </button>
  );
}

/**
 * Bloco fixo no topo da ficha (spec 014, US-D1/SUP-D1, lex D1.1/D1.2; D255/QA-caça rodada 1
 * item 2). `completeness = { missing, blocking, ready, canActivate }` vem PRONTO do backend
 * (`GET /:id`) — este componente só apresenta, NUNCA afirma bloqueio para um código fora de
 * `blocking` (o gate real de `POST /activate` só lê `blocking`; D255).
 *
 * Estados, em ordem de prioridade:
 *   1. `ready` (missing:[])            → "Admisión completa" — nada falta, nem bloqueio nem pendência.
 *   2. `canActivate` (blocking:[])     → "Listo para activar" +, se `missing` não vazio, a lista
 *      "Pendiente para la admisión completa:" com o que falta (recomendação, não bloqueio).
 *   3. `!canActivate` (blocking≠[])    → "Para activar falta:" SÓ com `blocking`, e — se sobrar
 *      algo de `missing` fora de `blocking` — a mesma lista de pendências abaixo.
 */
export function CompletenessChecklist({ completeness, onFocusItem }: CompletenessChecklistProps) {
  const { t } = useTranslation();
  const tc: TranslateChecklist = (key, opts) => t(`admin.patients.detail.completeness.${key}`, opts);

  const { missing, blocking, ready, canActivate } = completeness;
  // Pendente = falta, mas NÃO bloqueia o activate (missing ∖ blocking) — D255.
  const pending = missing.filter((code) => !blocking.includes(code));

  if (ready) {
    return (
      <div
        className="bg-green-50 rounded-card border-[1.5px] border-green-600 px-6 py-4 mb-6 flex items-center gap-3"
        data-testid="completeness-checklist-ready"
      >
        <CircleCheck className="w-5 h-5 text-green-700 shrink-0" />
        <div>
          <Text as="span" size="sm" weight="semibold" className="text-green-800">
            {tc('completeTitle')}
          </Text>
          <Text as="p" size="sm" className="text-green-700">
            {tc('completeBody')}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-card border-[1.5px] px-6 py-4 mb-6 flex flex-col gap-3 ${
        canActivate ? 'bg-blue-50 border-blue-400' : 'bg-amber-50 border-amber-500'
      }`}
      data-testid="completeness-checklist"
    >
      {canActivate ? (
        <div className="flex items-center gap-2" data-testid="completeness-can-activate">
          <CircleCheck className="w-5 h-5 text-blue-700 shrink-0" />
          <Text as="span" size="sm" weight="semibold" className="text-blue-800">
            {tc('readyTitle')}
          </Text>
        </div>
      ) : (
        <>
          <Heading level={4} as="h3" weight="semibold" className="text-amber-800">
            {tc('title')}
          </Heading>
          <div className="flex flex-wrap gap-2">
            {blocking.map((code) => (
              <ChecklistItemButton
                key={code}
                code={code}
                tc={tc}
                onFocusItem={onFocusItem}
                testId="completeness-item"
                tone="blocking"
              />
            ))}
          </div>
        </>
      )}

      {pending.length > 0 && (
        <>
          <Heading level={4} as="h3" weight="semibold" className="text-gray-700">
            {tc('pendingTitle')}
          </Heading>
          <div className="flex flex-wrap gap-2">
            {pending.map((code) => (
              <ChecklistItemButton
                key={code}
                code={code}
                tc={tc}
                onFocusItem={onFocusItem}
                testId="completeness-pending-item"
                tone="pending"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
