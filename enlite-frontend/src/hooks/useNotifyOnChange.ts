/**
 * useNotifyOnChange — chama `onChange(value)` só quando `value` muda de fato (comparação `!==`),
 * nunca a cada render. Extraído de `VacancyFormSection` (três blocos `useRef` + `useEffect`
 * idênticos: submitting, complete, dirty — fase 4, `completar-vacante-em-rascunho`) para parar de
 * repetir o mesmo par de linhas a cada novo callback "avisa o pai quando isto mudar".
 */
import { useEffect, useRef } from 'react';

export function useNotifyOnChange<T>(value: T, onChange?: (value: T) => void): void {
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) {
      onChange?.(value);
      prev.current = value;
    }
  }, [value, onChange]);
}
