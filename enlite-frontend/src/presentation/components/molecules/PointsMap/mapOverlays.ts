/**
 * Peças do PointsMap que não são React: ícones de pino/centro, overlays HTML
 * (rótulo de anel, casa do centro) e bounds do círculo. `google` só existe
 * depois do load — por isso nada aqui roda no import.
 */
import type { MapPoint, MapRing } from './PointsMap';

/**
 * ⚠️ As flags do arco vão SEPARADAS (`0 1 1 0-5`), nunca na forma compacta
 * (`0 110-5`) dos ícones minificados: o SVG aceita as duas, o parser de
 * `google.maps.Symbol` só aceita a primeira. Com a compacta ele lança
 * "Expected number at position 109, found z" a cada redesenho e NENHUM pino
 * é desenhado — o mapa fica só com o centro e o círculo, e `data-markers`
 * continua marcando verde (ele conta o que a página quis, não o que o Google
 * pintou). Medido em 31/08 com controle positivo: compacta = 1 erro/0 pinos,
 * separada = 0 erros/desenha.
 */
const PIN_PATH =
  'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z';

/** Ponto do centro do raio. `scale` maior = pulso de confirmação do clique. */
export function centerIcon(scale: number): google.maps.Symbol {
  return { path: google.maps.SymbolPath.CIRCLE, scale, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 };
}

// ⚑8 (contraste AAA): branco/#F227AF = 3,69:1 e #180149/#F227AF = 4,99:1 (ambos < 7) → o rosa do anel atual vira
// BORDA + ponto, e o texto fica #180149 sobre branco (18,43:1). Concluído: #0A5540 sobre #E1F6EE = 7,80:1 (o canvas tinha #0B5E45 = 6,89:1).
const TONES = {
  idle: { bg: '#ffffff', fg: '#180149', border: 'transparent' },
  current: { bg: '#ffffff', fg: '#180149', border: '#F227AF' },
  done: { bg: '#E1F6EE', fg: '#0A5540', border: 'transparent' },
} as const;
const SVG = 'xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const HOUSE_SVG = `<svg ${SVG} width="16" height="16" viewBox="0 0 24 24"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const CHECK_SVG = `<svg ${SVG} width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;

export function houseElement(label?: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'points-map-center-house');
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); el.title = label; }
  el.style.cssText = 'width:34px;height:34px;border-radius:50%;background:#111827;border:3px solid #fff;box-shadow:0 4px 10px rgba(0,0,0,.25);color:#fff;display:flex;align-items:center;justify-content:center;pointer-events:none;box-sizing:border-box';
  el.innerHTML = HOUSE_SVG;
  return el;
}

export function ringLabelElement(text: string, tone: MapRing['labelTone']): HTMLElement {
  const el = document.createElement('div');
  const t = TONES[tone];
  el.setAttribute('data-testid', 'points-map-ring-label');
  el.style.cssText = `background:${t.bg};color:${t.fg};font:500 11px/16px Lexend,sans-serif;padding:2px 8px;border:1.5px solid ${t.border};border-radius:100px;box-shadow:0 4px 8px rgba(0,0,0,.06);display:inline-flex;align-items:center;gap:4px;white-space:nowrap;pointer-events:none`;
  if (tone === 'done') el.insertAdjacentHTML('beforeend', CHECK_SVG);
  if (tone === 'current') el.insertAdjacentHTML('beforeend', '<span data-testid="points-map-ring-dot" style="width:6px;height:6px;border-radius:50%;background:#F227AF"></span>');
  el.appendChild(document.createTextNode(text));
  return el;
}

export interface HtmlOverlay { setMap: (m: google.maps.Map | null) => void; setPosition: (p: google.maps.LatLngLiteral) => void }
/** Elemento HTML ancorado numa coordenada (OverlayView criado sob demanda: `google` só existe após o load). */
export function htmlOverlay(el: HTMLElement, position: google.maps.LatLngLiteral, anchor: 'center' | 'top'): HtmlOverlay {
  class O extends google.maps.OverlayView {
    pos = position;
    onAdd(): void { this.getPanes()?.overlayLayer.appendChild(el); }
    draw(): void {
      const pt = this.getProjection()?.fromLatLngToDivPixel(new google.maps.LatLng(this.pos));
      if (!pt) return;
      el.style.position = 'absolute';
      el.style.left = `${pt.x}px`;
      el.style.top = `${pt.y}px`;
      el.style.transform = `translate(-50%, ${anchor === 'top' ? '-100%' : '-50%'})`;
    }
    onRemove(): void { el.remove(); }
  }
  const o = new O();
  return { setMap: (m) => o.setMap(m), setPosition: (p) => { o.pos = p; o.draw(); } };
}

/** Bounds (literal) do círculo de `km` ao redor de `c` — sem depender de classe do SDK. */
export function circleBounds(c: { lat: number; lng: number }, km: number): google.maps.LatLngBoundsLiteral {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.max(Math.cos((c.lat * Math.PI) / 180), 0.01));
  return { north: c.lat + dLat, south: c.lat - dLat, east: c.lng + dLng, west: c.lng - dLng };
}

export function dotIcon(p: MapPoint, emphasized: boolean): google.maps.Symbol {
  const st = p.style ?? { fill: p.color, stroke: '#ffffff', strokeWeight: 2, sizePx: 12 };
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: st.sizePx / 2,
    fillColor: st.fill,
    fillOpacity: 1,
    strokeColor: emphasized && st.outline ? '#180149' : st.stroke,
    strokeWeight: emphasized && st.outline ? st.strokeWeight + 1.5 : st.strokeWeight,
  };
}

export function pinIcon(color: string, emphasized = false): google.maps.Symbol {
  return {
    path: PIN_PATH,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: emphasized ? '#111827' : '#ffffff',
    strokeWeight: emphasized ? 2.5 : 1.5,
    scale: emphasized ? 2 : 1.4,
    anchor: new google.maps.Point(12, 22),
  };
}
