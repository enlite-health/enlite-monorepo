import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';

interface ProfileWizardFooterProps {
  isFirst: boolean;
  isLast: boolean;
  onPrev: () => void;
  onNext: () => void;
  onFinish: () => void;
}

/**
 * Rodapé de navegação do perfil do worker (Atrás / Siguiente / Finalizar).
 *
 * Resolve a crítica central do UX review (P0): com apenas o botão "Guardar"
 * isolado, o prestador não tinha como avançar de etapa e o fluxo "voltava ao
 * topo". O autosave por aba continua persistindo os dados; este rodapé só
 * conduz a navegação — `Siguiente` avança a aba, `Finalizar` (na última aba)
 * abre o resumo do que ainda falta.
 *
 * Ver docs/features/worker-registration-ux/ux-review-2026-06-28.md.
 */
export function ProfileWizardFooter({
  isFirst,
  isLast,
  onPrev,
  onNext,
  onFinish,
}: ProfileWizardFooterProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      data-testid="profile-wizard-footer"
      className="mt-6 flex items-center justify-between gap-3"
    >
      <Button
        type="button"
        variant="ghost"
        size="md"
        onClick={onPrev}
        disabled={isFirst}
        data-testid="wizard-back"
      >
        <span className="flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" />
          {t('profile.wizard.back', 'Atrás')}
        </span>
      </Button>

      {isLast ? (
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={onFinish}
          data-testid="wizard-finish"
        >
          <span className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            {t('profile.wizard.finish', 'Finalizar')}
          </span>
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={onNext}
          data-testid="wizard-next"
        >
          <span className="flex items-center gap-2">
            {t('profile.wizard.next', 'Siguiente')}
            <ArrowRight className="w-4 h-4" />
          </span>
        </Button>
      )}
    </div>
  );
}
