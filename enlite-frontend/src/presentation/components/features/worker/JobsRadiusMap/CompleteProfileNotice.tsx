import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import type { MissingProfileItem } from '@domain/entities/WorkerJobByRadius';
import { profileUrlFor } from './profileNoticeUrls';

interface CompleteProfileNoticeProps {
  missing: MissingProfileItem[];
}

/**
 * CompleteProfileNotice — o convite que ocupa o lugar do mapa e das vagas quando falta algo no cadastro (decisão do Gabriel,
 * 19/11): diz EXATAMENTE o que falta, com um botão por item levando à aba/campo certo do perfil. Tom de convite, nunca de erro
 * (nada de vermelho). Só nomeia os itens do cadastro: nunca valor nenhum do prestador.
 */
export function CompleteProfileNotice({ missing }: CompleteProfileNoticeProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <section
      data-testid="complete-profile-notice"
      aria-labelledby="complete-profile-title"
      className="mb-6 rounded-[20px] border border-[#d9d9d9] border-l-4 border-l-[#180149] bg-[#f3f0fa] p-5 font-lexend md:p-6"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-full bg-white p-2 text-[#180149]" aria-hidden="true"><Sparkles size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="complete-profile-title" className="text-lg font-semibold text-[#180149]">{t('profileNotice.title')}</h2>
          <p className="mt-1 text-sm text-[#4b3f72]">{t('profileNotice.intro')}</p>
          <ul className="mt-4 space-y-3">
            {missing.map((item) => (
              <li
                key={item}
                data-testid="profile-notice-item"
                data-item={item}
                className="flex flex-col gap-3 rounded-[14px] bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#180149]">{t(`profileNotice.items.${item}.label`)}</p>
                  <p className="text-xs text-[#737373]">{t(`profileNotice.items.${item}.why`)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(profileUrlFor(item))}
                  className="shrink-0 rounded-full bg-[#180149] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2a014d]"
                >
                  {t(`profileNotice.items.${item}.action`)}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-[#737373]">{t('profileNotice.footer')}</p>
        </div>
      </div>
    </section>
  );
}
