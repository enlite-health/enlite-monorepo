import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';

/**
 * RegistrationLockedNotice — o ÚNICO bloco que ocupa o lugar do mapa e da lista de vagas enquanto o cadastro do prestador está
 * incompleto (096, decisão do Gabriel): visual desabilitado, mensagem genérica, um botão. NUNCA lista o que falta, campo ou
 * critério de match. O destino é o mesmo do "Completar" do banner antigo da lista (`/worker/profile`).
 */
export function RegistrationLockedNotice(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <section
      data-testid="complete-profile-notice"
      aria-labelledby="registration-locked-title"
      className="mb-6 rounded-[20px] border border-[#d9d9d9] bg-gray-50 p-6 font-lexend"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-full bg-gray-200 p-2 text-[#4b4b4b]" aria-hidden="true"><Lock size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="registration-locked-title" className="text-lg font-semibold text-[#4b4b4b]">{t('registrationLocked.title')}</h2>
          <p className="mt-1 text-sm text-[#4b4b4b]">{t('registrationLocked.text')}</p>
          <button
            type="button"
            data-testid="complete-profile-cta"
            onClick={() => navigate('/worker/profile')}
            className="mt-4 rounded-full bg-[#180149] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2a014d]"
          >
            {t('registrationLocked.cta')}
          </button>
        </div>
      </div>
    </section>
  );
}
