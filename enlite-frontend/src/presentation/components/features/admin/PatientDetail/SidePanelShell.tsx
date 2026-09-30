import { useEffect, useRef, useState, type ReactNode } from 'react';

interface SidePanelShellProps {
  ariaLabel: string;
  onClose: () => void;
  /** Vai para o painel (role="dialog"). */
  testId: string;
  children: ReactNode;
}

const CLOSE_MS = 300;

/**
 * Casca do painel LATERAL da ficha do paciente (Figma 11340:76377): ancorado à direita, altura
 * cheia, cantos arredondados só à esquerda, overlay, sem X — fecha por overlay/Esc. Mesmo molde
 * (classes e animação de 300 ms) do `ContractedServiceDetailDrawer` e do painel do prestador do
 * encuadre, que ainda o trazem inline; esta casca é o ponto único para o itinerário, e quem
 * quiser pode migrar os outros para ela sem mudar visual. O conteúdo decide o próprio cabeçalho
 * (título + ação à direita na mesma linha).
 */
export function SidePanelShell({ ariaLabel, onClose, testId, children }: SidePanelShellProps): JSX.Element {
  const [show, setShow] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const close = (): void => {
    setShow(false);
    closeTimer.current = setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={close}
        data-testid={`${testId}-backdrop`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid={testId}
      >
        <div className="flex-1 overflow-y-auto pl-12 pr-6 py-10 flex flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
