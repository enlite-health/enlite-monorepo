import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RESOLUTION_CODES, type PresenceDecision, type ResolutionCode } from '@infrastructure/http/AdminPresenceReviewApiService';

interface Props {
  decision: PresenceDecision;
  enviando: boolean;
  /** Chave de i18n do erro da API, já traduzida pelo chamador via `presenceReviewErrorKey`. */
  erroKey: string | null;
  onConfirmar: (code: ResolutionCode) => void;
  onCancelar: () => void;
}

/**
 * A decisão da exceção de lugar EXIGE o código de resolução (lista fechada de 5, §3.5): nenhum vem marcado e o botão só habilita com um escolhido
 * (o backend também recusa sem código, com 400 — a tela não depende disso). Molde: `DecisaoModal` dos pedidos do Sol (`pedidos-ia`).
 * Cores explícitas (hex AAA sobre branco): a escala `gray-*` desta casa tem alpha e não serve para texto.
 */
export function ResolutionDialog({ decision, enviando, erroKey, onConfirmar, onCancelar }: Props): JSX.Element {
  const { t } = useTranslation();
  const [code, setCode] = useState<ResolutionCode | null>(null);
  const titleId = useId();
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelar();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancelar]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="presence-dialog" className="w-full max-w-lg rounded-[20px] bg-white p-5 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-[#1A1A1A]">{t(`admin.presenceReview.dialog.title.${decision}`)}</h2>
        <fieldset className="mt-3">
          <legend className="text-sm font-medium text-[#262626]">{t('admin.presenceReview.dialog.legend')}</legend>
          <div className="mt-2 space-y-2">
            {RESOLUTION_CODES.map((c, i) => (
              <label key={c} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border-2 border-[#595959] px-3 text-sm text-[#1A1A1A]">
                <input
                  ref={i === 0 ? firstRef : undefined}
                  type="radio"
                  name="presence-resolution"
                  value={c}
                  checked={code === c}
                  onChange={() => setCode(c)}
                  data-testid={`presence-resolution-${c}`}
                  className="h-4 w-4"
                />
                {t(`admin.presenceReview.resolution.${c}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {code === null && (
          <p className="mt-2 text-xs text-[#404040]" data-testid="presence-dialog-required">{t('admin.presenceReview.dialog.required')}</p>
        )}
        {erroKey && <p role="alert" data-testid="presence-dialog-error" className="mt-2 text-sm font-medium text-[#7A0C0C]">{t(erroKey)}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancelar} className="min-h-[44px] rounded-lg border-2 border-[#262626] bg-white px-4 text-sm font-semibold text-[#262626]">
            {t('admin.presenceReview.dialog.cancel')}
          </button>
          <button
            type="button"
            data-testid="presence-dialog-confirm"
            disabled={code === null || enviando}
            onClick={() => code && onConfirmar(code)}
            className="min-h-[44px] rounded-lg bg-[#262626] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('admin.presenceReview.dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
