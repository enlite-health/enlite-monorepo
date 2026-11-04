import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface SubstitutionModalShellProps {
  /** O nome da janela no topo à esquerda ("Nueva sustitución"). */
  title: string;
  /** A pergunta do passo ("¿Quién no va a venir?") — o título da área de conteúdo. */
  heading: string;
  /** Presente = "Paso N de M" + a régua de M barras (o fluxo de 4 passos); ausente = janela de um passo só. */
  progress?: { current: number; total: number };
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  'data-testid': string;
}

/**
 * A casca do modal de substituição (~540 px, mockup `modal-resumen.png`): topo com o nome, "Paso N de 4" e o X; régua de passos;
 * pergunta; conteúdo; rodapé com Atrás/Siguiente. Esc e o X fecham — o clique no fundo NÃO (um fluxo de 4 passos não se perde por
 * um clique torto). O foco entra na janela ao abrir.
 */
export function SubstitutionModalShell({ title, heading, progress, onClose, children, footer, 'data-testid': testId }: SubstitutionModalShellProps): JSX.Element {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className="flex max-h-[calc(100vh-32px)] w-full max-w-[540px] flex-col gap-4 overflow-y-auto rounded-[24px] bg-white px-6 py-[22px] shadow-extra-large outline-none"
      >
        <div className="flex items-center gap-3">
          <Text as="span" size="sm" weight="medium" color="tertiary">
            {title}
          </Text>
          {progress && (
            <span className="ml-auto rounded-full bg-[#F1E8FF] px-3 py-[3px] text-[#3B0A8C]" data-testid="substitucion-paso">
              <Text as="span" size="xs" weight="semibold" color="inherit">
                {t('admin.patients.detail.itinerary.flow.step', { current: progress.current, total: progress.total })}
              </Text>
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('admin.patients.detail.itinerary.flow.close')}
            data-testid="substitucion-cerrar"
            className={`flex h-10 w-10 items-center justify-center rounded-full border-[1.5px] border-gray-600 text-primary ${progress ? '' : 'ml-auto'}`}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {progress && (
          <div className="flex gap-1.5" aria-hidden="true">
            {Array.from({ length: progress.total }, (_, i) => (
              <i key={i} className={`h-1.5 flex-1 rounded-full ${i < progress.current ? 'bg-clinic' : 'bg-[#E8E3EE]'}`} data-testid={`substitucion-barra-${i + 1}`} data-on={i < progress.current} />
            ))}
          </div>
        )}

        <Heading level={3} as="h4" weight="semibold" color="primary">
          {heading}
        </Heading>

        <div className="flex flex-col gap-3">{children}</div>

        <div className="mt-2 flex items-center justify-between gap-3">{footer}</div>
      </div>
    </div>
  );
}
