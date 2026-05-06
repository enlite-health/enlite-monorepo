import { useTranslation } from 'react-i18next';
import { Heading, ProgressBar, PercentageDisplay } from '@presentation/components/atoms';
import { ProgressSection } from '@presentation/components/molecules/ProgressSection';
import type { WorkerProfileProgress } from '../../../../types/workerProgress';

interface ProfileCompletionCardProps {
  progress: WorkerProfileProgress;
  onActionClick?: () => void;
  className?: string;
}

export const ProfileCompletionCard = ({
  progress,
  onActionClick,
  className = '',
}: ProfileCompletionCardProps): JSX.Element => {
  const { t } = useTranslation();

  return (
    <div
      data-testid="profile-completion-card"
      className={`w-full bg-white border-2 border-purple-100 rounded-2xl p-4 sm:p-6 shadow-sm ${className}`}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-4">
        <Heading level={2} color="primary" className="text-base sm:text-xl" as="h2">
          <span data-testid="profile-completion-title">
            🎯 {t('profile.completionCard.title')}
          </span>
        </Heading>
        <span data-testid="overall-percentage" className="self-start sm:self-auto">
          <PercentageDisplay percentage={progress.overallPercentage} size="lg" />
        </span>
      </div>

      <ProgressBar
        percentage={progress.overallPercentage}
        height="lg"
        animated
        className="mb-6"
      />

      <div className="flex flex-col gap-4 mb-6">
        {progress.sections.map((section) => (
          <ProgressSection key={section.id} section={section} />
        ))}
      </div>

      {progress.nextAction && (
        <button
          onClick={onActionClick}
          className="w-full px-6 py-3 bg-primary text-white rounded-full font-poppins font-semibold hover:bg-purple-700 transition-colors flex items-center justify-center gap-2"
        >
          {progress.nextAction.label}
          <span>→</span>
        </button>
      )}
    </div>
  );
};
