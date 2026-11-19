import { useTranslation } from 'react-i18next';
import { JOB_RADII_KM, type JobRadiusKm } from '@domain/entities/WorkerJobByRadius';

interface RadiusSliderProps {
  value: JobRadiusKm;
  count: number;
  onChange: (radiusKm: JobRadiusKm) => void;
}

/** Controle de raio de 6 paradas (5·10·15·20·50·100). `<input type=range>` nativo: setas do teclado e `aria-valuetext`. */
export function RadiusSlider({ value, count, onChange }: RadiusSliderProps): JSX.Element {
  const { t } = useTranslation();
  const index = JOB_RADII_KM.indexOf(value);
  const upTo = t('jobsRadius.upTo', { n: value });
  return (
    <div data-testid="radius-slider" className="w-full">
      <p className="font-lexend text-sm font-semibold text-[#180149]" data-testid="radius-up-to">{upTo}</p>
      <input
        type="range"
        min={0}
        max={JOB_RADII_KM.length - 1}
        step={1}
        value={index}
        onChange={(e) => onChange(JOB_RADII_KM[Number(e.target.value)])}
        aria-label={t('jobsRadius.sliderLabel')}
        aria-valuetext={upTo}
        data-testid="radius-range"
        className="my-2 w-full accent-[#180149]"
      />
      <div className="flex justify-between text-xs text-[#737373] font-lexend" aria-hidden="true">
        {JOB_RADII_KM.map((r) => (
          <span key={r} className={r === value ? 'font-semibold text-[#180149]' : ''}>{r}</span>
        ))}
      </div>
      <p className="mt-2 font-lexend text-base text-[#180149]" data-testid="radius-count" aria-live="polite">
        {t('jobsRadius.count', { count })}
      </p>
    </div>
  );
}
