import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';

interface NumericFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  id: string;
  label: string;
  testId: string;
}

/** Quanto tempo o aviso "só números" fica na tela depois da última letra recusada. */
export const AVISO_MS = 2500;

/** Tecla de um caractere só que NÃO faz parte de um número (dígitos, sinal, separador decimal). */
const ehLetraRecusada = (key: string): boolean => key.length === 1 && !/[0-9.,+-]/.test(key);

/**
 * Campo numérico que AVISA quando a pessoa digita letra. `type="number"` engole a letra em
 * silêncio — o navegador não mostra nada — e o Gabriel viu a operadora "não conseguindo digitar"
 * (06/09). A dica "Solo números" fica sempre visível; a letra recusada acende um aviso vermelho
 * por `AVISO_MS` e some sozinho. Nada muda no valor: o navegador continua recusando.
 */
// `forwardRef`: o `register()` do react-hook-form entrega um `ref`, e `ref` NÃO atravessa um
// componente de função como prop — sem isto o RHF não liga no input (valor pré-carregado some).
export const NumericField = forwardRef<HTMLInputElement, NumericFieldProps>(function NumericField(
  { id, label, testId, ...input },
  ref,
): JSX.Element {
  const { t } = useTranslation();
  const [avisando, setAvisando] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    input.onKeyDown?.(e);
    if (!ehLetraRecusada(e.key)) return;
    setAvisando(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAvisando(false), AVISO_MS);
  };

  return (
    <FormField
      label={label}
      htmlFor={id}
      optional
      hint={t('admin.patients.editDrawer.onlyNumbersHint')}
      hintBelow
      error={avisando ? t('admin.patients.editDrawer.onlyNumbersWarning') : undefined}
    >
      <InputWithIcon
        {...input}
        ref={ref}
        id={id}
        type="number"
        inputMode="decimal"
        inputSize="compact"
        data-testid={testId}
        onKeyDown={onKeyDown}
        aria-invalid={avisando || undefined}
      />
    </FormField>
  );
});
