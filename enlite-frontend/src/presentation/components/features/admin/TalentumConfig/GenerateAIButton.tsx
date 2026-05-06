import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GenerateAIButtonStatus = 'idle' | 'loading' | 'success' | 'error';

interface Props {
  status: GenerateAIButtonStatus;
  hasExistingContent: boolean;
  onClick: () => void;
  errorMessage?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GenerateAIButton({ status, hasExistingContent, onClick, errorMessage }: Props) {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.talentumConfig.generateAI.${k}`);

  const isLoading = status === 'loading';

  // Already has content → show "Re-generate" outline style
  if (hasExistingContent && status !== 'loading') {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onClick}
          disabled={isLoading}
          className="inline-flex items-center gap-2 h-[48px] px-8 rounded-full border-2 border-[#180149] text-[#180149] bg-transparent font-['Poppins'] font-semibold text-[16px] hover:bg-[#180149]/5 transition-colors disabled:opacity-50"
        >
          <Sparkles size={20} />
          {tc('regenerate')}
        </button>
        {status === 'error' && errorMessage && (
          <p className="text-sm text-red-600 font-['Lexend']">{errorMessage}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        className="inline-flex items-center gap-2 h-[48px] px-8 rounded-full bg-[#180149] text-white font-['Poppins'] font-semibold text-[16px] hover:bg-[#180149]/90 transition-colors disabled:opacity-50"
      >
        {isLoading ? (
          <>
            <Loader2 size={20} className="animate-spin" />
            {tc('generating')}
          </>
        ) : (
          <>
            <Sparkles size={20} />
            {tc('generate')}
          </>
        )}
      </button>
      {status === 'error' && errorMessage && (
        <p className="text-sm text-red-600 font-['Lexend']">{errorMessage}</p>
      )}
    </div>
  );
}
