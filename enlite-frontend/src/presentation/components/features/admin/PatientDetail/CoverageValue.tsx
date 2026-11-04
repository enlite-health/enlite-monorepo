import { Text } from '@presentation/components/atoms/Text';
import type { CurrentCoverageDisplay } from './currentCoverageText';

/**
 * O valor de "Cobertura actual" (spec 064/087): uma pílula por obra social (+ "Particular"), ou o texto dos demais estados.
 * Quem decide QUAL dos dois é `currentCoverageDisplay` — o único decisor; esta peça só desenha o que ele devolveu. Dois leitores:
 * o cartão de identidade e o cartão "Cobertura médica" (a mesma função, o mesmo desenho: nunca um segundo decisor).
 */
export function CoverageValue({ display }: { display: CurrentCoverageDisplay }) {
  if (display.kind === 'text') return <>{display.text}</>;
  return (
    <span className="flex flex-wrap gap-1.5 max-w-full">
      {display.names.map((name) => (
        <span key={name} className="inline-flex max-w-full px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700" title={name}>
          <Text as="span" size="xs" weight="medium" color="inherit" className="min-w-0 truncate">
            {name}
          </Text>
        </span>
      ))}
    </span>
  );
}
