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

/**
 * Que aviso uma tecla merece. Medido no Chromium (es-AR, en-US, pt-BR) em 06/09: num
 * `type="number"`, digitar `1500,50` vira **`150050`** — a vírgula é DESCARTADA em silêncio e o
 * valor fica 100× maior. Num "valor por hora" isso é dinheiro. Por isso a vírgula é BLOQUEADA
 * (`preventDefault`) com aviso próprio; letra também avisa (o navegador já a recusa).
 */
const avisoPara = (key: string): 'letra' | 'virgula' | null => {
  if (key === ',') return 'virgula';
  if (key.length === 1 && !/[0-9.+-]/.test(key)) return 'letra';
  return null;
};

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
  const [avisando, setAvisando] = useState<'letra' | 'virgula' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    input.onKeyDown?.(e);
    const aviso = avisoPara(e.key);
    if (!aviso) return;
    if (aviso === 'virgula') e.preventDefault(); // senão o navegador engole e o número fica 100× maior
    setAvisando(aviso);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAvisando(null), AVISO_MS);
  };

  return (
    <FormField
      label={label}
      htmlFor={id}
      optional
      hint={t('admin.patients.editDrawer.onlyNumbersHint')}
      hintBelow
      error={avisando === 'letra'
        ? t('admin.patients.editDrawer.onlyNumbersWarning')
        : avisando === 'virgula' ? t('admin.patients.editDrawer.decimalCommaWarning') : undefined}
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
        aria-invalid={avisando ? true : undefined}
      />
    </FormField>
  );
});
