import { ProgressStepItem } from '../ProgressStepItem';
import { Heading, Text, ProgressBar } from '@presentation/components/atoms';
import type { ProgressSection as ProgressSectionType } from '../../../../types/workerProgress';

interface ProgressSectionProps {
  section: ProgressSectionType;
  className?: string;
}

export const ProgressSection = ({
  section,
  className = '',
}: ProgressSectionProps): JSX.Element => {
  return (
    <div data-testid={`section-${section.id}`} className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{section.icon}</span>
        <Heading level={3} color="primary">
          {section.title}
        </Heading>
        <Text as="span" size="xs" color="tertiary">
          ({section.completedCount}/{section.totalCount})
        </Text>
        {section.percentage === 100 ? (
          <Text as="span" size="xs" weight="semibold" color="primary">100%</Text>
        ) : (
          <Text as="span" size="xs" color="secondary">{section.percentage}%</Text>
        )}
      </div>
      <ProgressBar
        percentage={section.percentage}
        height="sm"
        animated
        className="mb-1"
      />
      <div className="flex flex-col">
        {section.steps.map((step) => (
          <ProgressStepItem
            key={step.id}
            label={step.label}
            status={step.status}
            indent
          />
        ))}
      </div>
    </div>
  );
};
