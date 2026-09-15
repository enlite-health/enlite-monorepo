export const ENV = {
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
  API_WORKER_FUNCTIONS_URL: import.meta.env.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:3000',
  FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY || '',
  FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  FIREBASE_STORAGE_BUCKET: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  FIREBASE_MESSAGING_SENDER_ID: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID || '',
  FIREBASE_AUTH_EMULATOR: import.meta.env.VITE_FIREBASE_AUTH_EMULATOR || '',
  CLARITY_PROJECT_ID: import.meta.env.VITE_CLARITY_PROJECT_ID || '',
  // Public patient intake (Task 1) — lead scheduling step (decisão D8).
  // Mode selects the LeadSchedulingProvider impl: 'embed' (Google Appointment
  // Schedule iframe, now) | 'native' (backend slot finder via DWD, future).
  LEAD_SCHEDULING_MODE: (import.meta.env.VITE_LEAD_SCHEDULING_MODE || 'embed') as 'embed' | 'native',
  // URL of the Google Appointment Schedule for the "consulta de admisión".
  // Empty → GoogleAppointmentEmbed renders a configure-URL warning.
  ADMISSION_BOOKING_URL: import.meta.env.VITE_ADMISSION_BOOKING_URL || '',
  // Spec 018, PR-4 (task 4.10): slot de foto + card de documentos do paciente — LIGADA só no
  // build da stage; AUSENTE (portanto desligada) em PRD, sem tocar em workflow de PRD. Achado da
  // revisão do PR-4 (item 6): a flag nunca tinha sido implementada — a feature aparecia sem gate
  // nenhum, em qualquer build. Ver `.github/workflows/deploy-stage-frontend.yml` para onde a env
  // do build da stage é setada.
  PATIENT_PHOTO_ENABLED: import.meta.env.VITE_PATIENT_PHOTO_ENABLED === 'true',
  IS_PRODUCTION: import.meta.env.PROD,
  IS_DEVELOPMENT: import.meta.env.DEV,
} as const;

export function validateEnv(): void {
  if (!ENV.FIREBASE_API_KEY) {
    throw new Error('VITE_FIREBASE_API_KEY is required');
  }
  if (!ENV.FIREBASE_PROJECT_ID) {
    throw new Error('VITE_FIREBASE_PROJECT_ID is required');
  }
}
