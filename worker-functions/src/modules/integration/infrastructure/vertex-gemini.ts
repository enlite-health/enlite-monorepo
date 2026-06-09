/**
 * vertex-gemini
 *
 * Calls the Vertex AI `generateContent` REST endpoint using Application
 * Default Credentials — the Cloud Run service account in prod, or
 * `gcloud auth application-default login` locally. No API key.
 *
 * Replaces the old `generativelanguage.googleapis.com?key=API_KEY` path:
 * the API key was a plaintext env var that could be (and was, 2026-06-09)
 * revoked server-side, taking down ALL AI generation with an opaque
 * "API Key not found" 400. ADC tokens auto-refresh and carry no secret in
 * the deployment, so there is nothing to rotate or leak.
 *
 * Reuses `fetchGeminiWithRetry` so the request body, retry/backoff and
 * error-message format stay identical to the previous path — callers and
 * their JSON parsing are unchanged.
 */

import { GoogleAuth } from 'google-auth-library';
import { fetchGeminiWithRetry } from './gemini-fetch';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// `global` gives the best Gemini availability and is Google's recommended
// default for Gemini 2.5. Override with VERTEX_LOCATION to pin a region.
function location(): string {
  return process.env.VERTEX_LOCATION ?? 'global';
}

let authClient: GoogleAuth | undefined;
let projectIdCache: string | undefined;

function getAuth(): GoogleAuth {
  if (!authClient) {
    authClient = new GoogleAuth({ scopes: CLOUD_PLATFORM_SCOPE });
  }
  return authClient;
}

function vertexHost(loc: string): string {
  return loc === 'global'
    ? 'aiplatform.googleapis.com'
    : `${loc}-aiplatform.googleapis.com`;
}

/**
 * POSTs `body` to the Vertex `generateContent` endpoint for `model`,
 * authenticating via ADC. Returns the raw Response (caller reads `.json()`).
 *
 * @param model  Publisher model id, e.g. `gemini-2.5-pro`.
 * @param body   The generateContent request body (systemInstruction,
 *               contents, generationConfig). Identical to the old payload.
 * @param logTag Short tag prefixed to log lines (e.g. 'TalentumDesc').
 * @throws On non-transient HTTP errors / exhausted retries (via
 *         fetchGeminiWithRetry) or when no ADC token can be resolved.
 */
export async function generateContentVertex(
  model: string,
  body: Record<string, unknown>,
  logTag: string,
): Promise<Response> {
  const auth = getAuth();
  if (!projectIdCache) {
    projectIdCache =
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCP_PROJECT_ID ??
      (await auth.getProjectId());
  }
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('Vertex AI: could not obtain an ADC access token');
  }

  const loc = location();
  const url =
    `https://${vertexHost(loc)}/v1/projects/${projectIdCache}` +
    `/locations/${loc}/publishers/google/models/${model}:generateContent`;

  return fetchGeminiWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
    logTag,
  );
}
