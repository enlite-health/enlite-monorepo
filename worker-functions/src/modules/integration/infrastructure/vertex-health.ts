/**
 * vertex-health
 *
 * Minimal Vertex AI reachability probe for the post-deploy smoke test.
 *
 * Proves the RUNNING Cloud Run revision can authenticate via ADC and call
 * Vertex with the configured model/region/permission — the exact path that
 * broke (silently) when the old API key was revoked server-side. Wiring it
 * into the deploy gate turns "proven once, manually" into "verified on every
 * deploy": if the service account loses roles/aiplatform.user, or the region
 * /model becomes unavailable, the deploy fails instead of shipping a broken
 * AI feature.
 *
 * Throws on any failure (generateContentVertex throws on non-2xx / no token).
 */

import { generateContentVertex } from './vertex-gemini';

export async function pingVertex(): Promise<{ model: string; ms: number }> {
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';
  const start = Date.now();

  // Tiny request — we only care that Vertex accepts the call with the
  // revision's credentials. Content/finishReason is irrelevant: a 2xx (the
  // only case where generateContentVertex returns instead of throwing) means
  // ADC + roles/aiplatform.user + model + region are all healthy.
  const res = await generateContentVertex(
    model,
    {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8 },
    },
    'VertexHealth',
  );
  await res.json();

  return { model, ms: Date.now() - start };
}
