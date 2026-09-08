/**
 * loadGoogleMaps
 *
 * Single-flight loader for the Google Maps JS API. Multiple consumers
 * (`ServiceAreaMap`, `GooglePlacesAutocomplete`, …) call this and share the
 * same script tag — never injecting more than one. Resolves once `google.maps`
 * is fully ready.
 */

declare global {
  interface Window {
    google?: typeof google;
  }
}

import { googleMapsScriptUrl } from './googleMapsScriptUrl';

let loadingPromise: Promise<void> | null = null;

const SCRIPT_SELECTOR = 'script[src*="maps.googleapis.com/maps/api/js"]';
const POST_LOAD_GRACE_MS = 100;

export function loadGoogleMaps(): Promise<void> {
  // ⚠️ Sem teste, e de propósito: em jsdom `window` SEMPRE existe, então este
  // ramo é inalcançável pela suíte. Esta aplicação não tem SSR — o guard é
  // herança defensiva. Por isso o arquivo fica fora do piso de 100% no
  // `vitest.config.ts`, com a razão escrita lá. Quem tirar o guard, tira também
  // a exceção.
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps loader called outside browser'));
  }

  if (typeof google !== 'undefined' && google.maps) {
    return Promise.resolve();
  }

  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise<void>((resolve, reject) => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey || apiKey === 'TODO_GOOGLE_MAPS_API_KEY') {
      loadingPromise = null;
      reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not configured'));
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR);
    if (existing) {
      existing.addEventListener('load', () => setTimeout(resolve, POST_LOAD_GRACE_MS));
      existing.addEventListener('error', () => {
        loadingPromise = null;
        reject(new Error('Failed to load Google Maps script'));
      });
      return;
    }

    const script = document.createElement('script');
    script.src = googleMapsScriptUrl(apiKey);
    script.async = true;
    script.defer = true;
    script.onload = () => setTimeout(resolve, POST_LOAD_GRACE_MS);
    script.onerror = () => {
      loadingPromise = null;
      reject(new Error('Failed to load Google Maps script'));
    };
    document.head.appendChild(script);
  });

  return loadingPromise;
}
