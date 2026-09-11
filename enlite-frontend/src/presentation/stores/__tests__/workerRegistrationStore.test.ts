import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkerRegistrationStore, getWorkerStorageKey } from '../workerRegistrationStore';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

describe('workerRegistrationStore', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    // Reset store to initial state
    useWorkerRegistrationStore.getState().reset();
  });

  describe('Initial State', () => {
    it('should have correct initial state', () => {
      const state = useWorkerRegistrationStore.getState();
      
      expect(state.currentStep).toBe('general-info');
      expect(state.currentStepIndex).toBe(0);
      expect(state.workerId).toBeNull();
      expect(state.mode).toBe('self');
      expect(state.completedSteps.size).toBe(0);
      expect(state.readonlyFields.size).toBe(0);
    });

    it('should have correct initial data structure', () => {
      const state = useWorkerRegistrationStore.getState();
      
      expect(state.data.generalInfo).toEqual({
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
        country: '',
      });

      expect(state.data.serviceAddress).toEqual({
        serviceRadius: 10,
        address: '',
        complement: '',
        acceptsRemoteService: false,
      });

      expect(state.data.availability.schedule).toHaveLength(7);
    });
  });

  describe('Step Navigation', () => {
    it('should set current step correctly', () => {
      const { setCurrentStep } = useWorkerRegistrationStore.getState();
      
      setCurrentStep('service-address');
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('service-address');
      expect(state.currentStepIndex).toBe(1);
    });

    it('should go to next step', () => {
      const { goToNextStep } = useWorkerRegistrationStore.getState();
      
      goToNextStep();
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('service-address');
      expect(state.currentStepIndex).toBe(1);
    });

    it('should not go beyond last step', () => {
      const { setCurrentStep, goToNextStep } = useWorkerRegistrationStore.getState();
      
      setCurrentStep('availability');
      goToNextStep();
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('availability');
      expect(state.currentStepIndex).toBe(2);
    });

    it('should go to previous step', () => {
      const { setCurrentStep, goToPreviousStep } = useWorkerRegistrationStore.getState();
      
      setCurrentStep('service-address');
      goToPreviousStep();
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('general-info');
      expect(state.currentStepIndex).toBe(0);
    });

    it('should not go before first step', () => {
      const { goToPreviousStep } = useWorkerRegistrationStore.getState();
      
      goToPreviousStep();
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('general-info');
      expect(state.currentStepIndex).toBe(0);
    });
  });

  describe('Step Completion', () => {
    it('should mark step as completed', () => {
      const { markStepCompleted, isStepCompleted } = useWorkerRegistrationStore.getState();
      
      markStepCompleted('general-info');
      
      expect(isStepCompleted('general-info')).toBe(true);
      expect(isStepCompleted('service-address')).toBe(false);
    });

    it('should mark step as incomplete', () => {
      const { markStepCompleted, markStepIncomplete, isStepCompleted } = useWorkerRegistrationStore.getState();
      
      markStepCompleted('general-info');
      expect(isStepCompleted('general-info')).toBe(true);
      
      markStepIncomplete('general-info');
      expect(isStepCompleted('general-info')).toBe(false);
    });

    it('should allow navigation to current or previous steps', () => {
      const { setCurrentStep, canGoToStep } = useWorkerRegistrationStore.getState();
      
      setCurrentStep('service-address');
      
      expect(canGoToStep('general-info')).toBe(true);
      expect(canGoToStep('service-address')).toBe(true);
    });

    it('should not allow navigation to next step if previous not completed', () => {
      const { canGoToStep } = useWorkerRegistrationStore.getState();
      
      expect(canGoToStep('service-address')).toBe(false);
      expect(canGoToStep('availability')).toBe(false);
    });

    it('should allow navigation to next step if all previous completed', () => {
      const { markStepCompleted, canGoToStep } = useWorkerRegistrationStore.getState();
      
      markStepCompleted('general-info');
      
      expect(canGoToStep('service-address')).toBe(true);
      expect(canGoToStep('availability')).toBe(false);
    });
  });

  describe('Data Updates', () => {
    it('should update general info data', () => {
      const { updateGeneralInfo } = useWorkerRegistrationStore.getState();
      
      updateGeneralInfo({
        fullName: 'John Doe',
        email: 'john@example.com',
      });
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.data.generalInfo.fullName).toBe('John Doe');
      expect(state.data.generalInfo.email).toBe('john@example.com');
      expect(state.data.generalInfo.cpf).toBe(''); // unchanged
    });

    it('should update service address data', () => {
      const { updateServiceAddress } = useWorkerRegistrationStore.getState();
      
      updateServiceAddress({
        address: '123 Main St',
        serviceRadius: 20,
      });
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.data.serviceAddress.address).toBe('123 Main St');
      expect(state.data.serviceAddress.serviceRadius).toBe(20);
    });

    it('should update availability data', () => {
      const { updateAvailability } = useWorkerRegistrationStore.getState();
      
      const newSchedule = [
        { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
      ];
      
      updateAvailability({
        schedule: newSchedule as any,
      });
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.data.availability.schedule).toEqual(newSchedule);
    });
  });

  describe('Mode Management', () => {
    it('should set mode to manager', () => {
      const { setMode } = useWorkerRegistrationStore.getState();
      
      setMode('manager');
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.mode).toBe('manager');
    });

    it('should set mode to self', () => {
      const { setMode } = useWorkerRegistrationStore.getState();
      
      setMode('manager');
      setMode('self');
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.mode).toBe('self');
    });
  });

  describe('Worker ID Management', () => {
    it('should set worker ID', () => {
      const { setWorkerId } = useWorkerRegistrationStore.getState();
      
      setWorkerId('worker-123');
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.workerId).toBe('worker-123');
    });
  });

  describe('Readonly Fields', () => {
    it('should set readonly fields', () => {
      const { setReadonlyFields, isFieldReadonly } = useWorkerRegistrationStore.getState();
      
      setReadonlyFields(['email', 'phone']);
      
      expect(isFieldReadonly('email')).toBe(true);
      expect(isFieldReadonly('phone')).toBe(true);
      expect(isFieldReadonly('fullName')).toBe(false);
    });

    it('should check if field is readonly', () => {
      const { setReadonlyFields, isFieldReadonly } = useWorkerRegistrationStore.getState();
      
      setReadonlyFields(['email']);
      
      expect(isFieldReadonly('email')).toBe(true);
      expect(isFieldReadonly('cpf')).toBe(false);
    });
  });

  describe('Server Hydration', () => {
    it('should hydrate from server data at step 1', () => {
      const { hydrateFromServer } = useWorkerRegistrationStore.getState();

      // No step1 fields → hydrateFromServer derives general-info (step 0)
      const serverData: WorkerProgressResponse = {
        id: 'worker-123',
        authUid: 'auth-123',
        email: 'worker@example.com',
        phone: '+5511999999999',
        status: 'pending',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      expect(state.workerId).toBe('worker-123');
      expect(state.currentStep).toBe('general-info');
      expect(state.currentStepIndex).toBe(0);
      expect(state.data.generalInfo.email).toBe('worker@example.com');
      expect(state.data.generalInfo.phone).toBe('+5511999999999');
      expect(state.completedSteps.size).toBe(0);
    });

    it('should hydrate from server data at step 2', () => {
      const { hydrateFromServer } = useWorkerRegistrationStore.getState();

      // Etapa 1 completa, etapa 2 pendente → deriva service-address (step 1).
      // Quem diz o que falta é o BACKEND (`missingFields`), não a contagem de
      // campos desta fixture — os campos ficam só para hidratar a tela.
      const serverData: WorkerProgressResponse = {
        missingFields: ['worker_service_areas', 'worker_availability', 'worker_documents'],
        id: 'worker-123',
        authUid: 'auth-123',
        email: 'worker@example.com',
        phone: '+5511999999999',
        status: 'in_progress',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        firstName: 'Ana',
        lastName: 'García',
        birthDate: '1990-05-15',
        sex: 'female',
        gender: 'female',
        documentType: 'CUIL_CUIT',
        documentNumber: '27123456789',
        languages: ['es'],
        profession: 'caregiver',
        knowledgeLevel: 'technical',
        experienceTypes: ['adhd'],
        yearsExperience: '3_5',
        preferredTypes: ['adhd'],
        preferredAgeRange: ['adolescents'],
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('service-address');
      expect(state.currentStepIndex).toBe(1);
      expect(state.completedSteps.has('general-info')).toBe(true);
      expect(state.completedSteps.size).toBe(1);
    });

    it('should hydrate from server data at step 3', () => {
      const { hydrateFromServer } = useWorkerRegistrationStore.getState();

      // Etapas 1 e 2 completas, disponibilidade pendente → deriva availability
      // (step 2). O veredito vem do backend, não da contagem de campos.
      const serverData: WorkerProgressResponse = {
        missingFields: ['worker_availability', 'worker_documents'],
        id: 'worker-123',
        authUid: 'auth-123',
        email: 'worker@example.com',
        status: 'in_progress',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        firstName: 'Ana',
        lastName: 'García',
        birthDate: '1990-05-15',
        sex: 'female',
        gender: 'female',
        documentType: 'CUIL_CUIT',
        documentNumber: '27123456789',
        languages: ['es'],
        profession: 'caregiver',
        knowledgeLevel: 'technical',
        experienceTypes: ['adhd'],
        yearsExperience: '3_5',
        preferredTypes: ['adhd'],
        preferredAgeRange: ['adolescents'],
        serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
        serviceRadiusKm: 10,
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('availability');
      expect(state.currentStepIndex).toBe(2);
      expect(state.completedSteps.has('general-info')).toBe(true);
      expect(state.completedSteps.has('service-address')).toBe(true);
      expect(state.completedSteps.size).toBe(2);
    });

    it('deve hidratar todos os campos de generalInfo do servidor', () => {
      const { hydrateFromServer } = useWorkerRegistrationStore.getState();

      const serverData: WorkerProgressResponse = {
        id: 'worker-999',
        authUid: 'auth-999',
        email: 'gabriel@example.com',
        phone: '+5491199999999',
        status: 'pending',
        country: 'AR',
        timezone: 'America/Argentina/Buenos_Aires',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        firstName: 'Gabriel',
        lastName: 'Stein',
        birthDate: '1990-04-18',
        sex: 'male',
        gender: 'male',
        documentType: 'CUIL_CUIT',
        documentNumber: '12345678',
        languages: ['pt', 'es'],
        profession: 'caregiver',
        knowledgeLevel: 'technical',
        titleCertificate: 'Cert XYZ',
        experienceTypes: ['adhd'],
        yearsExperience: '3_5',
        preferredTypes: ['adhd'],
        preferredAgeRange: ['adolescents'],
        profilePhotoUrl: 'https://example.com/photo.jpg',
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      const gi = state.data.generalInfo;

      expect(gi.email).toBe('gabriel@example.com');
      expect(gi.phone).toBe('+5491199999999');
      expect(gi.fullName).toBe('Gabriel');
      expect(gi.lastName).toBe('Stein');
      expect(gi.birthDate).toBe('1990-04-18');
      expect(gi.sex).toBe('male');
      expect(gi.gender).toBe('male');
      expect(gi.documentType).toBe('CUIL_CUIT');
      expect(gi.cpf).toBe('12345678');
      expect(gi.languages).toEqual(['pt', 'es']);
      expect(gi.profession).toBe('caregiver');
      expect(gi.knowledgeLevel).toBe('technical');
      expect(gi.professionalLicense).toBe('Cert XYZ');
      expect(gi.experienceTypes).toEqual(['adhd']);
      expect(gi.yearsExperience).toBe('3_5');
      expect(gi.preferredTypes).toEqual(['adhd']);
      expect(gi.preferredAgeRange).toEqual(['adolescents']);
      expect(gi.profilePhoto).toBe('https://example.com/photo.jpg');
    });

    it('deve hidratar serviceAddress do servidor', () => {
      const { hydrateFromServer } = useWorkerRegistrationStore.getState();

      const serverData: WorkerProgressResponse = {
        id: 'worker-999',
        authUid: 'auth-999',
        email: 'worker@example.com',
        status: 'pending',
        country: 'AR',
        timezone: 'UTC',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
        serviceAddressComplement: 'Piso 3',
        serviceRadiusKm: 20,
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      expect(state.data.serviceAddress.address).toBe('Av. Corrientes 1234, Buenos Aires');
      expect(state.data.serviceAddress.complement).toBe('Piso 3');
      expect(state.data.serviceAddress.serviceRadius).toBe(20);
    });

    it('deve manter dados do localStorage quando servidor retorna campos ausentes', () => {
      const { updateGeneralInfo, hydrateFromServer } = useWorkerRegistrationStore.getState();

      // Pre-fill localStorage state
      updateGeneralInfo({ profession: 'nurse', yearsExperience: '1_3' });

      // Server returns minimal data (no profession, no yearsExperience)
      const serverData: WorkerProgressResponse = {
        id: 'worker-777',
        authUid: 'auth-777',
        email: 'worker@example.com',
        status: 'pending',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // profession and yearsExperience intentionally absent
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      // Falls back to localStorage values
      expect(state.data.generalInfo.profession).toBe('nurse');
      expect(state.data.generalInfo.yearsExperience).toBe('1_3');
    });

    it('servidor substitui arrays mesmo quando localStorage tem dados', () => {
      const { updateGeneralInfo, hydrateFromServer } = useWorkerRegistrationStore.getState();

      updateGeneralInfo({ languages: ['pt'], experienceTypes: ['elderly'] });

      const serverData: WorkerProgressResponse = {
        id: 'worker-888',
        authUid: 'auth-888',
        email: 'worker@example.com',
        status: 'pending',
        country: 'BR',
        timezone: 'UTC',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        languages: ['pt', 'es', 'en'],
        experienceTypes: ['adhd', 'autism'],
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      expect(state.data.generalInfo.languages).toEqual(['pt', 'es', 'en']);
      expect(state.data.generalInfo.experienceTypes).toEqual(['adhd', 'autism']);
    });
  });

  describe('Reset', () => {
    it('should reset to initial state', () => {
      const { updateGeneralInfo, markStepCompleted, setWorkerId, setMode, reset } = useWorkerRegistrationStore.getState();
      
      // Make changes
      updateGeneralInfo({ fullName: 'Test User' });
      markStepCompleted('general-info');
      setWorkerId('worker-123');
      setMode('manager');
      
      // Reset
      reset();
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('general-info');
      expect(state.currentStepIndex).toBe(0);
      expect(state.workerId).toBeNull();
      expect(state.mode).toBe('self');
      expect(state.data.generalInfo.fullName).toBe('');
      expect(state.completedSteps.size).toBe(0);
    });
  });

  describe('Clear Persisted Data', () => {
    it('should clear all persisted data from localStorage', () => {
      const { clearPersistedData } = useWorkerRegistrationStore.getState();
      
      // Add some data to localStorage
      localStorage.setItem('worker-registration-user1', 'data1');
      localStorage.setItem('worker-registration-user2', 'data2');
      localStorage.setItem('other-key', 'data3');
      
      clearPersistedData();
      
      expect(localStorage.getItem('worker-registration-user1')).toBeNull();
      expect(localStorage.getItem('worker-registration-user2')).toBeNull();
      expect(localStorage.getItem('other-key')).toBe('data3'); // Should not be cleared
    });
  });

  describe('Storage Key Generation', () => {
    it('should generate storage key with user ID', () => {
      const key = getWorkerStorageKey('user-123');
      expect(key).toBe('worker-registration-user-123');
    });

    it('should generate anonymous storage key without user ID', () => {
      const key = getWorkerStorageKey();
      expect(key).toBe('worker-registration-anonymous');
    });

    it('should generate anonymous storage key with undefined user ID', () => {
      const key = getWorkerStorageKey(undefined);
      expect(key).toBe('worker-registration-anonymous');
    });
  });

  describe('Persistence', () => {
    it('should persist state to localStorage', () => {
      const { updateGeneralInfo, setWorkerId } = useWorkerRegistrationStore.getState();
      
      updateGeneralInfo({ fullName: 'Persisted User' });
      setWorkerId('worker-persist');
      
      // Check localStorage
      const stored = localStorage.getItem('worker-registration-anonymous');
      expect(stored).toBeTruthy();
      
      const parsed = JSON.parse(stored!);
      expect(parsed.state.data.generalInfo.fullName).toBe('Persisted User');
      expect(parsed.state.workerId).toBe('worker-persist');
    });

    it('should rehydrate completedSteps as Set', () => {
      const { markStepCompleted } = useWorkerRegistrationStore.getState();
      
      markStepCompleted('general-info');
      
      // Simulate page reload by creating new store instance
      const newState = useWorkerRegistrationStore.getState();
      expect(newState.completedSteps).toBeInstanceOf(Set);
      expect(newState.completedSteps.has('general-info')).toBe(true);
    });

    it('should rehydrate readonlyFields as Set', () => {
      const { setReadonlyFields } = useWorkerRegistrationStore.getState();
      
      setReadonlyFields(['email', 'phone']);
      
      // Simulate page reload
      const newState = useWorkerRegistrationStore.getState();
      expect(newState.readonlyFields).toBeInstanceOf(Set);
      expect(newState.readonlyFields.has('email')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing fields in hydrateFromServer (defaults to general-info)', () => {
      const { hydrateFromServer } = useWorkerRegistrationStore.getState();

      // No step1 or step2 fields → step is derived as general-info
      const serverData: WorkerProgressResponse = {
        id: 'worker-123',
        authUid: 'auth-123',
        email: 'worker@example.com',
        status: 'pending',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      hydrateFromServer(serverData);

      const state = useWorkerRegistrationStore.getState();
      expect(state.currentStep).toBe('general-info'); // Should default to first step
    });

    it('should handle partial data updates', () => {
      const { updateGeneralInfo } = useWorkerRegistrationStore.getState();
      
      updateGeneralInfo({ fullName: 'John' });
      updateGeneralInfo({ email: 'john@example.com' });
      
      const state = useWorkerRegistrationStore.getState();
      expect(state.data.generalInfo.fullName).toBe('John');
      expect(state.data.generalInfo.email).toBe('john@example.com');
    });

    it('should handle multiple step completions', () => {
      const { markStepCompleted, isStepCompleted } = useWorkerRegistrationStore.getState();
      
      markStepCompleted('general-info');
      markStepCompleted('service-address');
      markStepCompleted('availability');
      
      expect(isStepCompleted('general-info')).toBe(true);
      expect(isStepCompleted('service-address')).toBe(true);
      expect(isStepCompleted('availability')).toBe(true);
    });

    it('should handle empty readonly fields', () => {
      const { setReadonlyFields, isFieldReadonly } = useWorkerRegistrationStore.getState();
      
      setReadonlyFields([]);
      
      expect(isFieldReadonly('email')).toBe(false);
      expect(isFieldReadonly('phone')).toBe(false);
    });
  });
});
