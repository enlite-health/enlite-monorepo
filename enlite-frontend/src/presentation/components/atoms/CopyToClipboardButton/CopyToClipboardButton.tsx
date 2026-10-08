import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Copy, Check } from 'lucide-react';

export interface CopyToClipboardButtonProps {
  /** O texto EXATO que vai para a área de transferência. */
  text: string;
  /** Rótulo acessível do estado normal ("Copiar enlace"). */
  label: string;
  /** Rótulo acessível durante os 2 s depois de copiar ("Enlace copiado"). */
  copiedLabel: string;
  'data-testid'?: string;
}

const FEEDBACK_MS = 2000;

/**
 * Botão atômico de copiar (spec 047, F3): ícone Copy → Check por 2 s. `navigator.clipboard` pode não existir
 * (contexto inseguro) ou recusar (permissão) — a falha é engolida de propósito: copiar é conveniência, e
 * nenhum erro de clipboard pode derrubar a linha em que o botão mora. Sem `Check` quando falhou.
 * `stopPropagation`: o botão mora em linhas clicáveis (a tabela abre o detalhe do serviço).
 */
export function CopyToClipboardButton({ text, label, copiedLabel, 'data-testid': testId }: CopyToClipboardButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleClick = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      data-testid={testId}
      className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {copied ? <Check className="w-4 h-4 text-green-700" data-testid="copy-done-icon" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}
