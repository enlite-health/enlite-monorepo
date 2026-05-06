import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ServiceAreaMap } from '../ServiceAreaMap';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('ServiceAreaMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows placeholder when both lat and lng are 0', () => {
    render(<ServiceAreaMap lat={0} lng={0} />);
    expect(screen.getByTestId('service-area-map-placeholder')).toBeTruthy();
  });

  it('shows placeholder when coordinates are not yet set', () => {
    render(<ServiceAreaMap lat={0} lng={0} className="custom" />);
    const placeholder = screen.getByTestId('service-area-map-placeholder');
    expect(placeholder.className).toContain('custom');
  });

  it('shows the i18n placeholder text', () => {
    render(<ServiceAreaMap lat={0} lng={0} />);
    expect(screen.getByText('workerRegistration.serviceAddress.mapPlaceholder')).toBeTruthy();
  });

  it('renders the map container when valid coordinates are given', async () => {
    // Minimal google.maps stub
    const mockSetCenter = vi.fn();
    const mockMap = { setCenter: mockSetCenter };
    const mockMarker = { setPosition: vi.fn() };

    const googleStub = {
      maps: {
        Map: vi.fn().mockImplementation(() => mockMap),
        Marker: vi.fn().mockImplementation(() => mockMarker),
        event: { clearInstanceListeners: vi.fn() },
      },
    };

    (globalThis as any).google = googleStub;

    render(<ServiceAreaMap lat={-34.6037} lng={-58.3816} />);

    // Map container is rendered synchronously based on coords; init happens
    // inside `loadGoogleMaps().then(...)` so we wait for the async wiring.
    const mapDiv = screen.getByTestId('service-area-map');
    expect(mapDiv).toBeTruthy();

    await waitFor(() => {
      expect(googleStub.maps.Map).toHaveBeenCalled();
      expect(googleStub.maps.Marker).toHaveBeenCalledWith(
        expect.objectContaining({ position: { lat: -34.6037, lng: -58.3816 } }),
      );
    });

    delete (globalThis as any).google;
  });

  it('re-centres the map when coordinates change', async () => {
    const mockSetCenter = vi.fn();
    const mockSetPosition = vi.fn();
    const mockMap = { setCenter: mockSetCenter };
    const mockMarker = { setPosition: mockSetPosition };

    const googleStub = {
      maps: {
        Map: vi.fn().mockImplementation(() => mockMap),
        Marker: vi.fn().mockImplementation(() => mockMarker),
        event: { clearInstanceListeners: vi.fn() },
      },
    };
    (globalThis as any).google = googleStub;

    const { rerender } = render(<ServiceAreaMap lat={-34.6037} lng={-58.3816} />);
    await waitFor(() => expect(googleStub.maps.Map).toHaveBeenCalled());

    rerender(<ServiceAreaMap lat={-23.5505} lng={-46.6333} />);

    await waitFor(() => {
      expect(mockSetCenter).toHaveBeenLastCalledWith({ lat: -23.5505, lng: -46.6333 });
      expect(mockSetPosition).toHaveBeenLastCalledWith({ lat: -23.5505, lng: -46.6333 });
    });

    delete (globalThis as any).google;
  });
});
