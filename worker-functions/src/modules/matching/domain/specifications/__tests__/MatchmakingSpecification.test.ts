import { DataRealm } from '@shared/domain/DataRealm';
import { composeSpecifications } from '../MatchmakingSpecification';
import { SameRealmSpecification } from '../SameRealmSpecification';
import { ProfessionSpecification } from '../ProfessionSpecification';

describe('composeSpecifications', () => {
  it('encadeia os placeholders de cada spec em sequência, sem colisão', () => {
    const composed = composeSpecifications(
      [
        new ProfessionSpecification(['AT']),
        new SameRealmSpecification(DataRealm.TEST),
      ],
      1,
    );

    expect(composed.sql).toBe(
      '($2::JSONB IS NULL OR $2::JSONB ? COALESCE(w.occupation, w.profession)) AND (w.is_test = $3::boolean)',
    );
    expect(composed.params).toEqual([JSON.stringify(['AT']), true]);
  });

  it('lista vazia de specs → sql vazia, sem params', () => {
    const composed = composeSpecifications([], 1);

    expect(composed.sql).toBe('');
    expect(composed.params).toEqual([]);
  });
});
