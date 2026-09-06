import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@presentation/components/molecules/FormField';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';

interface ClinicalTextareaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'value' | 'maxLength'> {
  /** id do textarea e base dos `data-testid`: `<id>` e `<id>-counter`. */
  id: string;
  label: string;
  /** Valor corrente (`watch(name)`); o form pode entregar `undefined` — conta como vazio. */
  value: string | undefined;
  maxChars: number;
}

/**
 * Campo de texto clínico do drawer (REQ-01 · D211.2): textarea grande com contador e
 * `data-clarity-mask` — o Clarity está vivo em PRD e o modo padrão não mascara texto corrido
 * (lex 29/08, C1.1). Encaminha o `ref` para o `register` do react-hook-form.
 *
 * Rótulo `compact` e sem "(opcional)" — decisão do drawer clínico (05/09): todos os campos dele são
 * opcionais, e o contador em `muted` (cinza a 50% de opacidade) não se lia.
 */
export const ClinicalTextareaField = forwardRef<HTMLTextAreaElement, ClinicalTextareaFieldProps>(
  function ClinicalTextareaField({ id, label, value, maxChars, ...textareaProps }, ref) {
    const { t } = useTranslation();
    const count = (value ?? '').length;
    return (
      <FormField label={label} htmlFor={id} labelSize="compact">
        <div data-clarity-mask="True" className="flex flex-col gap-1">
          <Textarea id={id} ref={ref} inputSize="compact" resize="vertical" maxLength={maxChars} data-testid={id} {...textareaProps} />
          <span className="self-end" data-testid={`${id}-counter`}>
            <Text as="span" size="xs" color="secondary">
              {t('admin.patients.detail.diagnosisCard.generalNotesCounter', { count, max: maxChars })}
            </Text>
          </span>
        </div>
      </FormField>
    );
  },
);
