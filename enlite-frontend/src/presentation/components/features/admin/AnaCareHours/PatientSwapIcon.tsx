/**
 * Ícone "trocar" (spec 032): duas setas curvas sólidas — a de cima aponta para a direita, a de baixo
 * (a mesma, girada 180°) para a esquerda, formando um ciclo. SVG próprio (sem arquivo de terceiros),
 * `fill="currentColor"` e tamanho em `em`, para acompanhar a cor e a fonte do título ao lado.
 */
export function PatientSwapIcon(): JSX.Element {
  const arrow = 'M2 12.5C2 8.4 5.4 5 9.5 5H15.5V2L22 7L15.5 12V9H9.5C7.5 9 6 10.6 6 12.5Z';
  return (
    <svg viewBox="0 0 24 24" width="0.8em" height="0.8em" fill="currentColor" aria-hidden="true" focusable="false" data-testid="anacare-hours-patient-switch-icon">
      <path d={arrow} />
      <path d={arrow} transform="rotate(180 12 12)" />
    </svg>
  );
}
