import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

interface HomeLoadErrorNoticeProps {
  onRetry: () => void;
}

/**
 * HomeLoadErrorNotice — quando a rota da home (`/api/workers/me/jobs?view=home`) falha, a home FALHA FECHADA (decisão do
 * Gabriel): nem mapa, nem vagas, nem a lista pública — só este cartão, no mesmo tom do RegistrationLockedNotice (convite, sem
 * vermelho), com "Reintentar" que refaz a chamada. Sem dado nenhum do prestador na tela.
 */
export function HomeLoadErrorNotice({ onRetry }: HomeLoadErrorNoticeProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      data-testid="home-load-error"
      role="alert"
      aria-labelledby="home-load-error-title"
      className="mb-6 rounded-[20px] border border-[#d9d9d9] border-l-4 border-l-[#180149] bg-[#f3f0fa] p-5 font-lexend md:p-6"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-full bg-white p-2 text-[#180149]" aria-hidden="true"><RefreshCw size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="home-load-error-title" className="text-lg font-semibold text-[#180149]">{t('homeLoadError.title')}</h2>
          <p className="mt-1 text-sm text-[#4b3f72]">{t('homeLoadError.body')}</p>
          <button
            type="button"
            data-testid="home-load-error-retry"
            onClick={onRetry}
            className="mt-4 rounded-full bg-[#180149] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2a014d]"
          >
            {t('homeLoadError.retry')}
          </button>
        </div>
      </div>
    </section>
  );
}
