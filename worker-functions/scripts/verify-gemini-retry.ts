/* eslint-disable no-console */
/**
 * verify-gemini-retry.ts — AD-HOC, NÃO RODAR EM CI
 *
 * Valida manualmente as duas mudanças do commit "fix(gemini): retry on
 * 5xx/429 + bump default to gemini-2.5-pro":
 *
 *   1. fetchGeminiWithRetry retenta em 503 e segue após resposta válida.
 *   2. GeminiVacancyParserService.parseFromText completa contra a API
 *      real usando o modelo configurado (gemini-2.5-pro por default).
 *
 * GASTA TOKENS DA API GEMINI. Rodar só sob demanda — está em scripts/
 * e não em __tests__/ exatamente para o Jest não pegar.
 *
 * Uso:
 *   cd worker-functions
 *   npx ts-node -r dotenv/config scripts/verify-gemini-retry.ts
 *
 * Pré-reqs:
 *   - GEMINI_API_KEY no .env
 *   - PROMPT_DOC_ID_AT setado e doc compartilhado com o service account
 *   - GOOGLE_APPLICATION_CREDENTIALS apontando pra chave do SA
 */

import * as http from 'http';
import { fetchGeminiWithRetry } from '../src/modules/integration/infrastructure/gemini-fetch';
import { GeminiVacancyParserService } from '../src/modules/integration/infrastructure/GeminiVacancyParserService';

// ── Check 1 — retry helper against fake 503s ────────────────────────

async function verifyRetry(): Promise<void> {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 503, message: 'overloaded' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server bind failed');
  const url = `http://127.0.0.1:${addr.port}/`;

  const start = Date.now();
  try {
    const res = await fetchGeminiWithRetry(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      'verify-retry',
    );
    const data = (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const elapsed = Date.now() - start;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (attempts === 3 && text === 'OK') {
      console.log(`✓ retry: 2x 503 → 200 (${attempts} tentativas, ${elapsed}ms — em prod o backoff dorme 0.5s+1.5s, aqui NODE_ENV=test torna 0)`);
    } else {
      console.error(`✗ retry: esperava 3 tentativas com text=OK, recebi attempts=${attempts}, text=${text}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('✗ retry: helper falhou:', err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

// ── Check 2 — real Gemini API call via parser ───────────────────────

const SAMPLE_TEXT = `Caso N° 9999.
Paciente: hombre de 67 años con diagnóstico de Alzheimer en estadio moderado, nivel de dependencia alto.
Se busca AT mujer, de 30 a 50 años, con experiencia en pacientes con demencia.
Horarios: Lunes a Viernes de 09:00 a 13:00.
Jornada: media jornada (4 horas).
Cantidad de prestadores: 1.
Zona: Belgrano, CABA.
Salario: $400.000 mensuales.
Día de pago: día 5.`;

async function verifyRealCall(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error('✗ real-call: GEMINI_API_KEY ausente, pulando');
    process.exitCode = 1;
    return;
  }
  if (!process.env.PROMPT_DOC_ID_AT) {
    console.error('✗ real-call: PROMPT_DOC_ID_AT ausente, pulando');
    process.exitCode = 1;
    return;
  }

  // The retry helper checks NODE_ENV — clear it so we exercise real backoff
  // semantics in case Gemini does throttle us.
  const prevNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;

  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';
  console.log(`→ chamando Gemini (model=${model})...`);
  const start = Date.now();
  try {
    const svc = new GeminiVacancyParserService();
    const result = await svc.parseFromText(SAMPLE_TEXT, 'AT');
    const elapsed = Date.now() - start;

    const v = result.vacancy;
    const checks: Array<[string, boolean, unknown]> = [
      ['case_number=9999', v.case_number === 9999, v.case_number],
      ['required_sex=F (mujer)', v.required_sex === 'F', v.required_sex],
      ['age_range_min=30', v.age_range_min === 30, v.age_range_min],
      ['age_range_max=50', v.age_range_max === 50, v.age_range_max],
      ['providers_needed=1', v.providers_needed === 1, v.providers_needed],
      ['schedule.length>=5 (Lun-Vie)', (v.schedule?.length ?? 0) >= 5, v.schedule?.length],
      ['questions geradas', result.prescreening.questions.length > 0, result.prescreening.questions.length],
    ];

    console.log(`\n=== resposta Gemini (${elapsed}ms) ===`);
    let failures = 0;
    for (const [label, ok, actual] of checks) {
      if (ok) console.log(`  ✓ ${label}`);
      else { console.log(`  ✗ ${label} — recebi: ${JSON.stringify(actual)}`); failures++; }
    }

    if (failures === 0) {
      console.log(`✓ real-call: parser respondeu com schema válido e campos coerentes (model=${model})`);
    } else {
      console.error(`✗ real-call: ${failures} asserções falharam — modelo pode não estar seguindo o prompt`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('✗ real-call: erro chamando Gemini:', err);
    process.exitCode = 1;
  } finally {
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  }
}

// ── Main ────────────────────────────────────────────────────────────

(async () => {
  console.log('--- verify-gemini-retry ---');
  await verifyRetry();
  await verifyRealCall();
  console.log('---');
  if (process.exitCode) {
    console.error('FALHOU. Veja mensagens acima.');
  } else {
    console.log('TUDO OK.');
  }
})().catch((e) => {
  console.error('crash:', e);
  process.exit(1);
});
