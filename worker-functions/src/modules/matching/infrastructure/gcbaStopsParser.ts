/**
 * gcbaStopsParser — lê o CSV de "Colectivos: paradas" do GCBA e devolve paradas
 * prontas para `transit_stops`. Puro: recebe texto, devolve objetos, não toca em
 * rede nem em banco (o script faz o I/O).
 *
 * A fonte (data.buenosaires.gob.ar, CC-BY-2.5-AR, medida em 05/09/2026 com
 * `Last-Modified: 28/10/2024`) tem duas peculiaridades que este arquivo existe
 * para absorver:
 *
 *  1. **Coordenada com vírgula decimal e entre aspas**: `"-58,3709946"`. Um
 *     `parseFloat` direto devolve `-58` — erro de 40 km, silencioso, e do tipo
 *     que passa em teste feito com dado inventado por quem escreveu o parser.
 *  2. **Até SEIS linhas por parada**, em colunas paralelas `L1..L6` com o
 *     sentido em `l1_sen..l6_sen`. É desta coluna que sai a resposta do
 *     corredor, então uma parada sem nenhuma linha não serve para nada e é
 *     descartada aqui, não no banco.
 *
 * O sentido (`I`/`V`, ida/volta) é LIDO e descartado de propósito: o corredor
 * responde "esta linha serve os dois pontos", e uma linha serve os dois sentidos
 * do mesmo par de pontos em algum horário. Guardar o sentido sugeriria uma
 * precisão de direção que o dado não sustenta sem a grade de horários — que não
 * existe (o GTFS de colectivos está congelado em 2019).
 */

export interface ParsedStop {
  externalId: string;
  name: string;
  latitude: number;
  longitude: number;
  lines: string[];
}

export interface ParseReport {
  stops: ParsedStop[];
  /** Linhas do CSV descartadas, por motivo. Zero em todas é o esperado. */
  skipped: { semCoordenada: number; foraDeFaixa: number; semLinha: number; semId: number };
}

/**
 * Faixa válida de coordenada. Existe porque a fonte oficial TEM defeito: medido
 * em 05/09/2026, a parada `fid=4412` ("1493 ASAMBLEA AV.") publica longitude
 * `-583445535` — o separador decimal se perdeu. Uma parada só, mas se a coluna
 * fosse `float` ela entraria calada e desenharia um ponto no Oceano Pacífico.
 * Quem barrou aqui foi o `NUMERIC(10,7)` da migration; esta validação traz o
 * barramento para o parser, onde ele é CONTADO em vez de derrubar a carga.
 *
 * A linha é DESCARTADA, nunca corrigida: adivinhar que o valor "queria ser"
 * -58.3445535 é inventar dado — plausível e não verificado.
 */
const LAT_RANGE = { min: -90, max: 90 };
const LNG_RANGE = { min: -180, max: 180 };

export function isPlausibleCoordinate(lat: number, lng: number): boolean {
  return lat >= LAT_RANGE.min && lat <= LAT_RANGE.max && lng >= LNG_RANGE.min && lng <= LNG_RANGE.max;
}

/** `"-58,3709946"` → `-58.3709946`. Devolve `null` para o que não é número. */
export function parseCoordinate(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.trim().replace(/^"|"$/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Divide uma linha de CSV respeitando aspas (o campo `DIRECCION` tem vírgulas). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // `""` dentro de campo entre aspas é uma aspa literal.
      if (inQuotes && line[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

export function parseGcbaStops(csv: string): ParseReport {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const skipped = { semCoordenada: 0, foraDeFaixa: 0, semLinha: 0, semId: 0 };
  if (rows.length < 2) return { stops: [], skipped };

  const header = splitCsvLine(rows[0]).map((h) => h.trim().replace(/^﻿/, ''));
  const at = (cols: string[], name: string): string => {
    const i = header.indexOf(name);
    return i === -1 ? '' : (cols[i] ?? '').trim().replace(/^"|"$/g, '');
  };

  const stops: ParsedStop[] = [];
  for (const row of rows.slice(1)) {
    const cols = splitCsvLine(row);
    const externalId = at(cols, 'fid');
    if (externalId === '') { skipped.semId += 1; continue; }

    const latitude = parseCoordinate(at(cols, 'coord_Y'));
    const longitude = parseCoordinate(at(cols, 'coord_X'));
    if (latitude === null || longitude === null) { skipped.semCoordenada += 1; continue; }
    if (!isPlausibleCoordinate(latitude, longitude)) { skipped.foraDeFaixa += 1; continue; }

    // L1..L6: a mesma linha pode repetir entre colunas; `Set` normaliza.
    const lines = [...new Set(
      [1, 2, 3, 4, 5, 6].map((i) => at(cols, `L${i}`)).filter((l) => l !== ''),
    )];
    if (lines.length === 0) { skipped.semLinha += 1; continue; }

    const direccion = at(cols, 'DIRECCION');
    const barrio = at(cols, 'BARRIO');
    stops.push({
      externalId,
      name: [direccion, barrio].filter((s) => s !== '').join(' · ') || `Parada ${externalId}`,
      latitude,
      longitude,
      lines,
    });
  }
  return { stops, skipped };
}
