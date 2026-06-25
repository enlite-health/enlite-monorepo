import { describe, it, expect } from 'vitest';
import {
  destinationFor,
  firstPendingTab,
  buildProfileUrl,
  type TabId,
} from '../incompleteFieldDestinations';

// ── destinationFor ─────────────────────────────────────────────────────────────

describe('destinationFor', () => {
  describe('campos gerais — aba "general"', () => {
    it('first_name → tab:general, focus:fullName', () => {
      const dest = destinationFor('first_name');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('fullName');
    });

    it('last_name → tab:general, focus:lastName', () => {
      const dest = destinationFor('last_name');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('lastName');
    });

    it('sex → tab:general, focus:sex', () => {
      const dest = destinationFor('sex');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('sex');
    });

    it('gender → tab:general, focus:gender', () => {
      const dest = destinationFor('gender');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('gender');
    });

    it('birth_date → tab:general, focus:birthDate', () => {
      const dest = destinationFor('birth_date');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('birthDate');
    });

    it('document_number → tab:general, focus:cpf', () => {
      const dest = destinationFor('document_number');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('cpf');
    });

    it('phone → tab:general, focus:phone', () => {
      const dest = destinationFor('phone');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('phone');
    });

    it('languages → tab:general, focus:languages', () => {
      const dest = destinationFor('languages');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('languages');
    });

    it('profession → tab:general, focus:profession', () => {
      const dest = destinationFor('profession');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('profession');
    });

    it('knowledge_level → tab:general, focus:knowledgeLevel', () => {
      const dest = destinationFor('knowledge_level');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('knowledgeLevel');
    });

    it('title_certificate → tab:general, focus:professionalLicense', () => {
      const dest = destinationFor('title_certificate');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('professionalLicense');
    });

    it('years_experience → tab:general, focus:yearsExperience', () => {
      const dest = destinationFor('years_experience');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('yearsExperience');
    });

    it('experience_types → tab:general, focus:experienceTypes', () => {
      const dest = destinationFor('experience_types');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('experienceTypes');
    });

    it('preferred_types → tab:general, focus:preferredTypes', () => {
      const dest = destinationFor('preferred_types');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('preferredTypes');
    });

    it('preferred_age_range → tab:general, focus:preferredAgeRange', () => {
      const dest = destinationFor('preferred_age_range');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBe('preferredAgeRange');
    });
  });

  describe('aba "address"', () => {
    it('worker_service_areas → tab:address, sem focus', () => {
      const dest = destinationFor('worker_service_areas');
      expect(dest.tab).toBe('address');
      expect(dest.focus).toBeUndefined();
    });
  });

  describe('aba "availability"', () => {
    it('worker_availability → tab:availability, sem focus', () => {
      const dest = destinationFor('worker_availability');
      expect(dest.tab).toBe('availability');
      expect(dest.focus).toBeUndefined();
    });
  });

  describe('documentos — aba "documents"', () => {
    it('doc_resume_cv → tab:documents, focus:resume_cv', () => {
      const dest = destinationFor('doc_resume_cv');
      expect(dest.tab).toBe('documents');
      expect(dest.focus).toBe('resume_cv');
    });

    it('doc_identity_document → tab:documents, focus:identity_document', () => {
      const dest = destinationFor('doc_identity_document');
      expect(dest.tab).toBe('documents');
      expect(dest.focus).toBe('identity_document');
    });

    it('doc_criminal_record → tab:documents, focus:criminal_record', () => {
      const dest = destinationFor('doc_criminal_record');
      expect(dest.tab).toBe('documents');
      expect(dest.focus).toBe('criminal_record');
    });

    it('doc_at_certificate → tab:documents, focus:at_certificate', () => {
      const dest = destinationFor('doc_at_certificate');
      expect(dest.tab).toBe('documents');
      expect(dest.focus).toBe('at_certificate');
    });
  });

  describe('token desconhecido — fallback seguro', () => {
    it('token desconhecido → tab:general sem focus', () => {
      const dest = destinationFor('unknown_token_xyz');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBeUndefined();
    });

    it('string vazia → tab:general sem focus', () => {
      const dest = destinationFor('');
      expect(dest.tab).toBe('general');
      expect(dest.focus).toBeUndefined();
    });
  });
});

// ── firstPendingTab ────────────────────────────────────────────────────────────

describe('firstPendingTab', () => {
  it('campo geral → "general"', () => {
    expect(firstPendingTab(['first_name'])).toBe<TabId>('general');
  });

  it('só doc → "documents"', () => {
    expect(firstPendingTab(['doc_resume_cv'])).toBe<TabId>('documents');
  });

  it('só worker_service_areas → "address"', () => {
    expect(firstPendingTab(['worker_service_areas'])).toBe<TabId>('address');
  });

  it('só worker_availability → "availability"', () => {
    expect(firstPendingTab(['worker_availability'])).toBe<TabId>('availability');
  });

  it('general + doc → "general" (prioridade)', () => {
    expect(firstPendingTab(['doc_resume_cv', 'first_name'])).toBe<TabId>('general');
  });

  it('address + documents → "address" (prioridade)', () => {
    expect(firstPendingTab(['doc_resume_cv', 'worker_service_areas'])).toBe<TabId>('address');
  });

  it('availability + documents → "availability" (prioridade)', () => {
    expect(firstPendingTab(['doc_resume_cv', 'worker_availability'])).toBe<TabId>('availability');
  });

  it('lista vazia → "general" (fallback)', () => {
    expect(firstPendingTab([])).toBe<TabId>('general');
  });

  it('só tokens desconhecidos → "general" (fallback)', () => {
    expect(firstPendingTab(['unknown_a', 'unknown_b'])).toBe<TabId>('general');
  });

  it('ordem general > address > availability > documents é respeitada', () => {
    const allTokens = [
      'doc_resume_cv',         // documents
      'worker_availability',   // availability
      'worker_service_areas',  // address
      'first_name',            // general
    ];
    expect(firstPendingTab(allTokens)).toBe<TabId>('general');

    const withoutGeneral = allTokens.filter((t) => t !== 'first_name');
    expect(firstPendingTab(withoutGeneral)).toBe<TabId>('address');

    const withoutAddress = withoutGeneral.filter((t) => t !== 'worker_service_areas');
    expect(firstPendingTab(withoutAddress)).toBe<TabId>('availability');

    const withoutAvailability = withoutAddress.filter((t) => t !== 'worker_availability');
    expect(firstPendingTab(withoutAvailability)).toBe<TabId>('documents');
  });
});

// ── buildProfileUrl ────────────────────────────────────────────────────────────

describe('buildProfileUrl', () => {
  it('campo geral com focus → URL com tab e focus', () => {
    const url = buildProfileUrl({ tab: 'general', focus: 'fullName' });
    expect(url).toBe('/worker/profile?tab=general&focus=fullName');
  });

  it('documento com focus → URL com tab=documents e focus', () => {
    const url = buildProfileUrl({ tab: 'documents', focus: 'resume_cv' });
    expect(url).toBe('/worker/profile?tab=documents&focus=resume_cv');
  });

  it('sem focus → URL apenas com tab', () => {
    const url = buildProfileUrl({ tab: 'address' });
    expect(url).toBe('/worker/profile?tab=address');
  });

  it('availability sem focus → URL apenas com tab', () => {
    const url = buildProfileUrl({ tab: 'availability' });
    expect(url).toBe('/worker/profile?tab=availability');
  });
});
