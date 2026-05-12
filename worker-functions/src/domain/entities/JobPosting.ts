export interface JobPosting {
  id: string;
  
  // Job details
  title: string;
  description: string;
  
  // Requirements (for matching)
  requiredProfession?: string;
  requiredExperienceYears?: string;
  requiredLanguages: string[];
  preferredAgeRange?: string;
  
  // Location (city/state removed — address lives in patient_addresses, see migration 152)
  country: 'AR' | 'BR';
  isRemote: boolean;
  
  // Compensation
  salaryRangeMin?: number;
  salaryRangeMax?: number;
  currency: 'ARS' | 'BRL' | 'USD';
  workSchedule?: string;  // 'full-time', 'part-time', 'flexible'
  
  // Configuration
  status: JobPostingStatus;
  maxApplicants?: number;
  currentApplicants: number;
  
  // Timestamps
  publishedAt?: Date;
  closesAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type JobPostingPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';

export type JobPostingStatus =
  | 'SEARCHING'             // Actively looking for a new AT
  | 'SEARCHING_REPLACEMENT' // Looking for a replacement AT
  | 'RAPID_RESPONSE'        // Emergency fast-response team
  | 'PENDING_ACTIVATION'    // Matched but waiting to start
  | 'ACTIVE'                // AT is operating normally
  | 'ON_HOLD'               // Paused for operational reasons (patient still active)
  | 'SUSPENDED'             // Temporarily paused (clinical suspension)
  | 'CLOSED';               // Case ended / cancelled / filled

export interface CreateJobPostingDTO {
  title: string;
  description: string;
  requiredProfession?: string;
  requiredExperienceYears?: string;
  requiredLanguages?: string[];
  preferredAgeRange?: string;
  country: 'AR' | 'BR';
  isRemote?: boolean;
  salaryRangeMin?: number;
  salaryRangeMax?: number;
  currency?: 'ARS' | 'BRL' | 'USD';
  workSchedule?: string;
  maxApplicants?: number;
}

export interface UpdateJobPostingDTO {
  id: string;
  title?: string;
  description?: string;
  status?: JobPostingStatus;
  maxApplicants?: number;
  closesAt?: Date;
}
