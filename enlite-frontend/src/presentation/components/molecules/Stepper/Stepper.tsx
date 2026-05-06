import { Check } from 'lucide-react';

export interface StepperStep {
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** 1-indexed current step. Steps before are "completed", steps after are "pending". */
  currentStep: number;
  className?: string;
}

/**
 * Horizontal numbered stepper. Used to show multi-step flows (e.g. vacancy
 * creation → Talentum config → detail). Visual only — does not handle navigation.
 */
export function Stepper({ steps, currentStep, className = '' }: StepperProps): JSX.Element {
  return (
    <ol className={`flex items-center w-full ${className}`} aria-label="Progress">
      {steps.map((step, idx) => {
        const stepNumber = idx + 1;
        const isCompleted = stepNumber < currentStep;
        const isCurrent = stepNumber === currentStep;
        const isLast = idx === steps.length - 1;

        const circleColor = isCompleted
          ? 'bg-[#180149] text-white border-[#180149]'
          : isCurrent
            ? 'bg-white text-[#180149] border-[#180149]'
            : 'bg-white text-[#737373] border-[#d9d9d9]';

        const labelColor = isCompleted || isCurrent
          ? 'text-[#180149]'
          : 'text-[#737373]';

        const lineColor = isCompleted ? 'bg-[#180149]' : 'bg-[#d9d9d9]';

        return (
          <li
            key={step.label}
            className={`flex items-center ${isLast ? '' : 'flex-1'}`}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full border-2 flex items-center justify-center font-['Lexend'] font-semibold text-[16px] shrink-0 transition-colors ${circleColor}`}
              >
                {isCompleted ? <Check className="w-5 h-5" /> : stepNumber}
              </div>
              <span
                className={`font-['Lexend'] font-medium text-[14px] whitespace-nowrap transition-colors ${labelColor}`}
              >
                {step.label}
              </span>
            </div>

            {!isLast && (
              <div className={`flex-1 h-[2px] mx-4 transition-colors ${lineColor}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
