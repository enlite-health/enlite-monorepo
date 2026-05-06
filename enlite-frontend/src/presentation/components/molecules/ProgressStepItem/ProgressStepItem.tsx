import { Check, AlertTriangle, Lock } from 'lucide-react';
import { Text } from '@presentation/components/atoms';
import type { StepStatus } from '../../../../types/workerProgress';

interface ProgressStepItemProps {
  label: string;
  status: StepStatus;
  indent?: boolean;
  className?: string;
}

export const ProgressStepItem = ({
  label,
  status,
  indent = false,
  className = '',
}: ProgressStepItemProps): JSX.Element => {
  return (
    <div
      className={`flex items-center gap-3 py-1.5 ${indent ? 'pl-6' : ''} ${className}`}
    >
      {status === 'completed' ? (
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
          <Check className="w-3 h-3 text-white" strokeWidth={3} />
        </div>
      ) : status === 'pending' ? (
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center">
          <AlertTriangle className="w-3 h-3 text-white" strokeWidth={2.5} />
        </div>
      ) : (
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center">
          <Lock className="w-3 h-3 text-gray-400" strokeWidth={2} />
        </div>
      )}
      <Text size="sm" color="primary">
        {label}
      </Text>
    </div>
  );
};
