import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { mergeGeneralInfo, mergeServiceAddress } from './workerRegistrationHydration';
import { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import { isStep1Complete, isStep2Complete } from '@presentation/utils/workerProgressValidation';

export type WorkerRegistrationStep = 
  | 'general-info' 
  | 'service-address' 
  | 'availability';

export interface GeneralInfoData {
  profilePhoto: string | null;
  fullName: string;
  lastName: string;
  cpf: string;
  phone: string;
  email: string;
  birthDate: string;
  sex: string;
  gender: string;
  documentType: string;
  professionalLicense: string;
  languages: string[];
  profession: string;
  knowledgeLevel: string;
  experienceTypes: string[];
  yearsExperience: string;
  preferredTypes: string[];
  preferredAgeRange: string[];
}

export interface ServiceAddressData {
  serviceRadius: number;
  address: string;
  complement: string;
  acceptsRemoteService: boolean;
}

export interface TimeSlot {
  startTime: string;
  endTime: string;
}

export interface DayAvailability {
  day: string;
  enabled: boolean;
  timeSlots: TimeSlot[];
}

export interface AvailabilityData {
  schedule: DayAvailability[];
}

export interface WorkerRegistrationData {
  generalInfo: GeneralInfoData;
  serviceAddress: ServiceAddressData;
  availability: AvailabilityData;
}

export const WORKER_REGISTRATION_STEPS: WorkerRegistrationStep[] = [
  'general-info',
  'service-address',
  'availability',
];

// Step number mapping: backend uses integers 1-3, frontend uses named steps

export const STEP_LABELS: Record<WorkerRegistrationStep, string> = {
  'general-info': 'Informações Gerais',
  'service-address': 'Endereço de atendimentos',
  'availability': 'Horários e Disponibilidade',
};

export type RegistrationMode = 'self' | 'manager';

interface WorkerRegistrationState {
  // Current step
  currentStep: WorkerRegistrationStep;
  currentStepIndex: number;
  
  // Worker record ID from backend
  workerId: string | null;
  
  // Registration mode
  mode: RegistrationMode;
  
  // Form data
  data: WorkerRegistrationData;
  
  // Readonly fields (for pre-filled data)
  readonlyFields: Set<string>;
  
  // Validation state per step
  completedSteps: Set<WorkerRegistrationStep>;
  
  // Actions
  setCurrentStep: (step: WorkerRegistrationStep) => void;
  goToNextStep: () => void;
  goToPreviousStep: () => void;
  canGoToStep: (step: WorkerRegistrationStep) => boolean;
  setMode: (mode: RegistrationMode) => void;
  setWorkerId: (id: string) => void;
  
  // Server hydration: restores full state from GET /api/workers/me
  /**
   * Sincroniza o store com o cadastro vindo do servidor.
   *
   * `authoritative: true` — usar DEPOIS de uma escrita: a resposta é o estado
   * real, então campo ausente vira vazio (o valor local não "vence"). Sem a
   * flag (carregamento de tela), o local é preservado quando o servidor devolve
   * vazio, para não apagar edição ainda não salva.
   */
  hydrateFromServer: (
    serverData: WorkerProgressResponse,
    options?: { authoritative?: boolean },
  ) => void;
  
  // Data updaters
  updateGeneralInfo: (data: Partial<GeneralInfoData>) => void;
  updateServiceAddress: (data: Partial<ServiceAddressData>) => void;
  updateAvailability: (data: Partial<AvailabilityData>) => void;
  
  // Readonly fields management
  setReadonlyFields: (fields: string[]) => void;
  isFieldReadonly: (field: string) => boolean;
  
  // Step completion
  markStepCompleted: (step: WorkerRegistrationStep) => void;
  markStepIncomplete: (step: WorkerRegistrationStep) => void;
  isStepCompleted: (step: WorkerRegistrationStep) => boolean;
  
  // Reset
  reset: () => void;
  clearPersistedData: () => void;
}

const initialData: WorkerRegistrationData = {
  generalInfo: {
    profilePhoto: null,
    fullName: '',
    lastName: '',
    cpf: '',
    phone: '',
    email: '',
    birthDate: '',
    sex: '',
    gender: '',
    documentType: 'CUIL_CUIT',
    professionalLicense: '',
    languages: [],
    profession: '',
    knowledgeLevel: '',
    experienceTypes: [],
    yearsExperience: '',
    preferredTypes: [],
    preferredAgeRange: [],
  },
  serviceAddress: {
    serviceRadius: 10,
    address: '',
    complement: '',
    acceptsRemoteService: false,
  },
  availability: {
    schedule: [
      { day: 'Domingo', enabled: false, timeSlots: [] },
      { day: 'Segunda', enabled: false, timeSlots: [] },
      { day: 'Terça', enabled: false, timeSlots: [] },
      { day: 'Quarta', enabled: false, timeSlots: [] },
      { day: 'Quinta', enabled: false, timeSlots: [] },
      { day: 'Sexta', enabled: false, timeSlots: [] },
      { day: 'Sábado', enabled: false, timeSlots: [] },
    ],
  },
};

/**
 * Returns the Zustand persist storage key scoped to the current user.
 * This prevents data leakage between different users on the same device.
 */
export function getWorkerStorageKey(userId?: string): string {
  return userId ? `worker-registration-${userId}` : 'worker-registration-anonymous';
}

export const useWorkerRegistrationStore = create<WorkerRegistrationState>()(
  persist(
    (set, get) => ({
      currentStep: 'general-info',
      currentStepIndex: 0,
      workerId: null,
      mode: 'self' as RegistrationMode,
      data: initialData,
      readonlyFields: new Set(),
      completedSteps: new Set(),

      setMode: (mode) => {
        set({ mode });
      },

      setWorkerId: (id) => {
        set({ workerId: id });
      },

      hydrateFromServer: (serverData, options) => {
        // Derive step from actual field data (currentStep column was removed from DB)
        let stepName: WorkerRegistrationStep = 'general-info';
        if (isStep1Complete(serverData) && isStep2Complete(serverData)) {
          stepName = 'availability';
        } else if (isStep1Complete(serverData)) {
          stepName = 'service-address';
        }
        const stepIndex = WORKER_REGISTRATION_STEPS.indexOf(stepName);

        // Mark all steps before currentStep as completed
        const completedSteps = new Set<WorkerRegistrationStep>();
        for (let i = 0; i < stepIndex; i++) {
          completedSteps.add(WORKER_REGISTRATION_STEPS[i]);
        }

        set((state) => ({
          workerId: serverData.id,
          currentStep: stepName,
          currentStepIndex: stepIndex,
          completedSteps,
          data: {
            ...state.data,
            generalInfo: mergeGeneralInfo(serverData, state.data.generalInfo, options),
            serviceAddress: mergeServiceAddress(serverData, state.data.serviceAddress, options),
          },
        }));
      },

      setReadonlyFields: (fields) => {
        set({ readonlyFields: new Set(fields) });
      },

      isFieldReadonly: (field) => {
        return get().readonlyFields.has(field);
      },

      setCurrentStep: (step) => {
        const stepIndex = WORKER_REGISTRATION_STEPS.indexOf(step);
        set({ currentStep: step, currentStepIndex: stepIndex });
      },

      goToNextStep: () => {
        const { currentStepIndex } = get();
        const nextIndex = currentStepIndex + 1;
        
        if (nextIndex < WORKER_REGISTRATION_STEPS.length) {
          const nextStep = WORKER_REGISTRATION_STEPS[nextIndex];
          set({ 
            currentStep: nextStep, 
            currentStepIndex: nextIndex 
          });
        }
      },

      goToPreviousStep: () => {
        const { currentStepIndex } = get();
        const prevIndex = currentStepIndex - 1;
        
        if (prevIndex >= 0) {
          const prevStep = WORKER_REGISTRATION_STEPS[prevIndex];
          set({ 
            currentStep: prevStep, 
            currentStepIndex: prevIndex 
          });
        }
      },

      canGoToStep: (step) => {
        const { completedSteps } = get();
        const targetIndex = WORKER_REGISTRATION_STEPS.indexOf(step);
        
        // Can always go to current or previous steps
        const currentIndex = get().currentStepIndex;
        if (targetIndex <= currentIndex) return true;
        
        // Can go to next step only if all previous are completed
        for (let i = 0; i < targetIndex; i++) {
          const stepKey = WORKER_REGISTRATION_STEPS[i];
          if (!completedSteps.has(stepKey)) return false;
        }
        
        return true;
      },

      updateGeneralInfo: (generalData) => {
        set((state) => ({
          data: {
            ...state.data,
            generalInfo: { ...state.data.generalInfo, ...generalData },
          },
        }));
      },

      updateServiceAddress: (addressData) => {
        set((state) => ({
          data: {
            ...state.data,
            serviceAddress: { ...state.data.serviceAddress, ...addressData },
          },
        }));
      },

      updateAvailability: (availabilityData) => {
        set((state) => ({
          data: {
            ...state.data,
            availability: { ...state.data.availability, ...availabilityData },
          },
        }));
      },

      markStepCompleted: (step) => {
        set((state) => {
          const newCompletedSteps = new Set(state.completedSteps);
          newCompletedSteps.add(step);
          return { completedSteps: newCompletedSteps };
        });
      },

      markStepIncomplete: (step) => {
        set((state) => {
          const newCompletedSteps = new Set(state.completedSteps);
          newCompletedSteps.delete(step);
          return { completedSteps: newCompletedSteps };
        });
      },

      isStepCompleted: (step) => {
        return get().completedSteps.has(step);
      },

      reset: () => {
        set({
          currentStep: 'general-info',
          currentStepIndex: 0,
          workerId: null,
          mode: 'self',
          data: initialData,
          readonlyFields: new Set(),
          completedSteps: new Set(),
        });
      },

      clearPersistedData: () => {
        // Clear all possible user-scoped keys
        Object.keys(localStorage).forEach((key) => {
          if (key.startsWith('worker-registration-')) localStorage.removeItem(key);
        });
        get().reset();
      },
    }),
    {
      name: 'worker-registration-anonymous', // overridden dynamically by WorkerRegistrationPage
      partialize: (state) => ({ 
        workerId: state.workerId,
        data: state.data,
        currentStep: state.currentStep,
        currentStepIndex: state.currentStepIndex,
        mode: state.mode,
        readonlyFields: Array.from(state.readonlyFields),
        completedSteps: Array.from(state.completedSteps),
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.completedSteps = new Set(state.completedSteps as unknown as WorkerRegistrationStep[]);
          state.readonlyFields = new Set(state.readonlyFields as unknown as string[]);
        }
      },
    }
  )
);
