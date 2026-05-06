import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { loadGoogleMaps } from '@infrastructure/services/loadGoogleMaps';

interface ServiceAreaMapProps {
  lat?: number | null;
  lng?: number | null;
  className?: string;
}

function isValidCoordinates(
  lat: number | null | undefined,
  lng: number | null | undefined,
): lat is number {
  return lat != null && lng != null && (lat !== 0 || lng !== 0);
}

/**
 * Renders a Google Maps embed with a Marker at the given coordinates.
 * Loads the Maps script on demand via `loadGoogleMaps`. Coordinates are
 * authoritative — they're populated by the backend at upsert time
 * (PatientService.replaceAddresses) and backfilled by the geocoding script
 * for legacy rows. If lat/lng are missing the placeholder card is shown
 * instead of geocoding client-side.
 */
export function ServiceAreaMap({
  lat,
  lng,
  className = '',
}: ServiceAreaMapProps): JSX.Element {
  const { t } = useTranslation();
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);

  const valid = isValidCoordinates(lat, lng);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapDivRef.current) return;
        const position = { lat: lat as number, lng: lng as number };

        if (!mapInstanceRef.current) {
          mapInstanceRef.current = new google.maps.Map(mapDivRef.current, {
            center: position,
            zoom: 15,
            disableDefaultUI: true,
            zoomControl: true,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
          });
          markerRef.current = new google.maps.Marker({
            position,
            map: mapInstanceRef.current,
          });
        } else {
          mapInstanceRef.current.setCenter(position);
          markerRef.current?.setPosition(position);
        }
      })
      .catch(() => {
        // Maps couldn't load (offline / missing key). Silent — placeholder
        // already covers the no-coords case; here we accept "no map" gracefully.
      });

    return () => {
      cancelled = true;
    };
  }, [lat, lng, valid]);

  if (!valid) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 w-full rounded-[10px] bg-gray-100 border border-dashed border-gray-300 ${className}`}
        style={{ height: 300 }}
        data-testid="service-area-map-placeholder"
      >
        <MapPin size={32} className="text-gray-400" />
        <span className="font-lexend text-sm text-gray-500 text-center px-4">
          {t('workerRegistration.serviceAddress.mapPlaceholder')}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={mapDivRef}
      className={`w-full rounded-[10px] overflow-hidden ${className}`}
      style={{ height: 300 }}
      data-testid="service-area-map"
    />
  );
}
