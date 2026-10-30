import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type DecisaoModo = 'negar' | 'descrever';

interface Props {
  modo: DecisaoModo;
  enviando: boolean;
  /** Chave de i18n do erro da API (403/409/400…), já traduzida pelo chamador via `pedidosIaErrorKey`. */
  erroKey: string | null;
  onConfirmar: (texto: string) => void;
  onCancelar: () => void;
}

/**
 * Modal da decisão que EXIGE texto: "Negar" pede o motivo, "Descrever o que fazer" pede o comentário.
 * Texto vazio ou só espaços desabilita o botão (o backend também recusa com 400 — a tela não depende disso).
 * Cores explícitas (hex AAA sobre branco): a escala `gray-*` desta casa tem alpha e não serve para texto.
 */
export function DecisaoModal({ modo, enviando, erroKey, onConfirmar, onCancelar }: Props): JSX.Element {
  const { t } = useTranslation();
  const [texto, setTexto] = useState('');
  const titleId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const vazio = texto.trim().length === 0;

  useEffect(() => {
    areaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelar();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancelar]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="decisao-modal"
        className="w-full max-w-lg rounded-[20px] bg-white p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-[#1A1A1A]">
          {t(`admin.pedidosIa.modal.${modo}.title`)}
        </h2>
        <label htmlFor={`${titleId}-texto`} className="mt-3 block text-sm font-medium text-[#262626]">
          {t(`admin.pedidosIa.modal.${modo}.label`)}
        </label>
        <textarea
          id={`${titleId}-texto`}
          ref={areaRef}
          data-testid="decisao-texto"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={4}
          aria-required="true"
          className="mt-1 w-full rounded-lg border-2 border-[#595959] p-2 text-sm text-[#1A1A1A]"
        />
        {vazio && (
          <p className="mt-1 text-xs text-[#404040]" data-testid="decisao-obrigatorio">
            {t(`admin.pedidosIa.modal.${modo}.required`)}
          </p>
        )}
        {erroKey && (
          <p role="alert" data-testid="decisao-erro" className="mt-2 text-sm font-medium text-[#7A0C0C]">
            {t(erroKey)}
          </p>
        )}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancelar}
            className="min-h-[44px] rounded-lg border-2 border-[#262626] bg-white px-4 text-sm font-semibold text-[#262626]"
          >
            {t('admin.pedidosIa.modal.cancel')}
          </button>
          <button
            type="button"
            data-testid="decisao-confirmar"
            disabled={vazio || enviando}
            onClick={() => onConfirmar(texto.trim())}
            className="min-h-[44px] rounded-lg bg-[#262626] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t(`admin.pedidosIa.modal.${modo}.confirm`)}
          </button>
        </div>
      </div>
    </div>
  );
}
