import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen, act } from '@testing-library/react';
import { AvailabilityTab } from '../AvailabilityTab';
import { Toaster } from '@presentation/components/molecules/Toaster';
import { useToastStore } from '@presentation/stores/toastStore';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';

const mockTriggerSave = vi.fn();
const mockSaveAvailability = vi.fn().mockResolvedValue(undefined);
const mockGetAvailability = vi.fn().mockResolvedValue([
  { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
]);
const mockGetProgress = vi.fn().mockResolvedValue({
  availability: [
    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
  ],
});

vi.mock('@presentation/hooks/useAutoSave', () => ({
  useAutoSave: vi.fn(),
}));

vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: vi.fn(),
}));

vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn((selector: (state: any) => any) => {
    const state = {
      data: {
        generalInfo: {
          profilePhoto: null, fullName: '', lastName: '', cpf: '', phone: '',
          email: '', birthDate: '', sex: '', gender: '', documentType: 'DNI',
          professionalLicense: '', languages: [], profession: '', knowledgeLevel: '',
          experienceTypes: [], yearsExperience: '', preferredTypes: [], preferredAgeRange: '',
        },
        serviceAddress: { serviceRadius: 10, address: '', complement: '', acceptsRemoteService: false },
        availability: {
          schedule: [
            { day: 'sunday', enabled: false, timeSlots: [] },
            { day: 'monday', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
            { day: 'tuesday', enabled: false, timeSlots: [] },
            { day: 'wednesday', enabled: false, timeSlots: [] },
            { day: 'thursday', enabled: false, timeSlots: [] },
            { day: 'friday', enabled: false, timeSlots: [] },
            { day: 'saturday', enabled: false, timeSlots: [] },
          ],
        },
      },
      isFieldReadonly: () => false,
    };
    return selector(state);
  }),
}));

describe('AvailabilityTab - Auto Save & Toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    vi.mocked(useAutoSave).mockReturnValue(mockTriggerSave);
    vi.mocked(useWorkerApi).mockReturnValue({
      saveAvailability: mockSaveAvailability,
      getAvailability: mockGetAvailability,
      getProgress: mockGetProgress,
      initWorker: vi.fn(),
      saveStep: vi.fn(),
      saveGeneralInfo: vi.fn(),
      saveServiceArea: vi.fn(),
    } as any);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('should call useAutoSave with a save function', () => {
    render(<AvailabilityTab />);
    expect(useAutoSave).toHaveBeenCalledWith(expect.any(Function), 500, expect.any(Function));
  });

  it('should trigger auto-save on container blur', () => {
    const { container } = render(<AvailabilityTab />);
    const wrapper = container.firstChild as HTMLElement;
    fireEvent.blur(wrapper);
    expect(mockTriggerSave).toHaveBeenCalled();
  });

  it('should call saveAvailability when auto-save function executes', async () => {
    render(<AvailabilityTab />);
    const saveFn = vi.mocked(useAutoSave).mock.calls[0][0];
    await saveFn();
    expect(mockSaveAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        availability: expect.any(Array),
      }),
    );
  });

  it('should trigger auto-save when adding a time slot', () => {
    const { container } = render(<AvailabilityTab />);
    // "+" buttons have an svg with path "M10 5V15M5 10H15"
    const addButtons = container.querySelectorAll('button[type="button"]');
    // Find buttons with the plus icon (add time slot buttons, not the save button)
    const addButton = Array.from(addButtons).find((btn) => {
      const svg = btn.querySelector('path[d="M10 5V15M5 10H15"]');
      return svg !== null;
    });

    if (addButton) {
      fireEvent.click(addButton);
      expect(mockTriggerSave).toHaveBeenCalled();
    }
  });

  it('should trigger auto-save when removing a time slot', () => {
    const { container } = render(<AvailabilityTab />);
    // Remove buttons have an svg with the X path
    const removeButton = container.querySelector(
      'button path[d="M8 9.7L2 15.7 0.3 14 6.3 8 0.3 2 2 0.3 8 6.3 14 0.3 15.7 2 9.7 8 15.7 14 14 15.7 8 9.7Z"]',
    )?.closest('button');

    if (removeButton) {
      fireEvent.click(removeButton);
      expect(mockTriggerSave).toHaveBeenCalled();
    }
  });

  it('shows a success toast when auto-save succeeds', async () => {
    mockSaveAvailability.mockResolvedValueOnce(undefined);
    render(<><AvailabilityTab /><Toaster /></>);

    await waitFor(() => expect(mockGetAvailability).toHaveBeenCalled());

    const saveFn = vi.mocked(useAutoSave).mock.calls[0][0];
    await act(async () => { await saveFn(); });

    expect(await screen.findByTestId('toast-success')).toBeTruthy();
  });

  it('shows an error toast when auto-save fails', async () => {
    render(<><AvailabilityTab /><Toaster /></>);

    await waitFor(() => expect(mockGetAvailability).toHaveBeenCalled());

    const onError = vi.mocked(useAutoSave).mock.calls[0][2]!;
    act(() => onError(new Error('Save failed')));

    expect(await screen.findByTestId('toast-error')).toBeTruthy();
  });
});
