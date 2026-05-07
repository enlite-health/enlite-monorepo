import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { loadGoogleMaps } from '@infrastructure/services/loadGoogleMaps';

interface ServiceAreaMapProps {
  lat?: number | null;
  lng?: number | null;
  /**
   * Fallback address text used to geocode client-side when `lat`/`lng` are
   * missing. Recovers legacy `patient_addresses` rows whose coordinates were
   * never backfilled — no DB write, just a one-shot Geocoder call per change.
   */
  address?: string | null;
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
 * Loads the Maps script on demand via `loadGoogleMaps`. Backend-supplied
 * coordinates take precedence; when missing, falls back to client-side
 * geocoding of the `address` prop so the pin still shows for legacy rows.
 * Only when both fail does the placeholder card render.
 */
export function ServiceAreaMap({
  lat,
  lng,
  address,
  className = '',
}: ServiceAreaMapProps): JSX.Element {
  const { t } = useTranslation();
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const [resolved, setResolved] = useState<{ lat: number; lng: number } | null>(null);

  const propsValid = isValidCoordinates(lat, lng);
  const effectiveLat = propsValid ? (lat as number) : resolved?.lat ?? null;
  const effectiveLng = propsValid ? (lng as number) : resolved?.lng ?? null;
  const valid = effectiveLat != null && effectiveLng != null;

  // Client-side geocoding fallback. Runs when the backend didn't supply
  // coords but we have an address string. Resets on address change so the
  // marker doesn't lag the user's selection.
  useEffect(() => {
    if (propsValid) return;
    setResolved(null);
    const query = address?.trim();
    if (!query) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled) return;
        const geocoder = new google.maps.Geocoder();
        return geocoder.geocode({ address: query, region: 'AR' });
      })
      .then((res) => {
        if (cancelled || !res) return;
        const loc = res.results?.[0]?.geometry.location;
        if (loc) setResolved({ lat: loc.lat(), lng: loc.lng() });
      })
      .catch(() => {
        // Geocoding failed (no key, quota, no result). Placeholder remains.
      });

    return () => {
      cancelled = true;
    };
  }, [address, propsValid]);

  // Drop stale Map/Marker refs when the map div unmounts (valid → invalid),
  // otherwise the next mount would try to setCenter on a detached instance.
  useEffect(() => {
    if (valid) return;
    mapInstanceRef.current = null;
    markerRef.current = null;
  }, [valid]);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapDivRef.current) return;
        const position = { lat: effectiveLat as number, lng: effectiveLng as number };

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
  }, [effectiveLat, effectiveLng, valid]);

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
