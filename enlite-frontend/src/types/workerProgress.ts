// diagnóstico de CI — este commit não deve ser mergeado
export type StepStatus = 'completed' | 'pending' | 'locked';

export interface RegistrationStep {
  id: string;
  label: string;
  status: StepStatus;
}

export interface DocumentItem {
  id: string;
  label: string;
  status: StepStatus;
  required: boolean;
}

export interface ProgressSection {
  id: string;
  title: string;
  icon: string;
  steps: RegistrationStep[] | DocumentItem[];
  completedCount: number;
  totalCount: number;
  percentage: number;
}

export interface WorkerProfileProgress {
  overallPercentage: number;
  sections: ProgressSection[];
  nextAction?: {
    label: string;
    route: string;
  };
}
