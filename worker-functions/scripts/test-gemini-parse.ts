/* eslint-disable no-console */
import * as fs from 'fs';
import {
  VACANCY_RESPONSE_SCHEMA,
  JSON_OUTPUT_INSTRUCTIONS,
} from '../src/modules/integration/infrastructure/gemini-vacancy-constants';
import { generateContentVertex } from '../src/modules/integration/infrastructure/vertex-gemini';

function loadEnv(p: string) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const l of lines) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv('/Users/gabrielstein-dev/projects/enlite/infra/.env');

const PDF_PATH = '/Users/gabrielstein-dev/Downloads/Pinto, Facundo Matias _ #86a6ekaby (1).pdf';

async function runOne(model: string) {
  const pdfBase64 = fs.readFileSync(PDF_PATH).toString('base64');

  const body = {
    systemInstruction: { parts: [{ text: JSON_OUTPUT_INSTRUCTIONS }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: VACANCY_RESPONSE_SCHEMA,
    },
  };

  // Vertex AI via ADC (sem API key). generateContentVertex lança em não-ok.
  const start = Date.now();
  let res: Response;
  try {
    res = await generateContentVertex(model, body, 'test-parse');
  } catch (err) {
    console.log(`\n=== ${model} FAILED in ${Date.now() - start}ms ===`);
    console.log(err instanceof Error ? err.message : String(err));
    return;
  }
  const elapsed = Date.now() - start;

  const data = (await res.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = JSON.parse(text);
  const v = parsed.vacancy;

  console.log(`\n=== ${model} (${elapsed}ms, tokens: in=${data.usageMetadata?.promptTokenCount} out=${data.usageMetadata?.candidatesTokenCount}) ===`);
  console.log('required_sex        :', v.required_sex);
  console.log('dependency_level    :', v.dependency_level);
  console.log('required_professions:', v.required_professions);
  console.log('age_range_min/max   :', v.age_range_min, '/', v.age_range_max);
  console.log('pathology_types     :', v.pathology_types);
  console.log('city / state        :', v.city, '/', v.state);
  console.log('schedule            :');
  for (const s of v.schedule) {
    const dayNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    console.log(`  ${dayNames[s.dayOfWeek]} ${s.startTime}-${s.endTime}`);
  }
  console.log('work_schedule       :', v.work_schedule);
  console.log('service_device_types:', v.service_device_types);
  console.log('providers_needed    :', v.providers_needed);
}

(async () => {
  if (!fs.existsSync(PDF_PATH)) { console.error('PDF not found'); process.exit(1); }
  console.log('PDF:', PDF_PATH, `(${(fs.statSync(PDF_PATH).size / 1024).toFixed(1)} KB)`);
  await runOne('gemini-2.5-flash');
  await runOne('gemini-2.5-pro');
})().catch((e) => { console.error(e); process.exit(1); });
