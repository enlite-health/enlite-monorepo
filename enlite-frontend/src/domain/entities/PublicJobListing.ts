export interface PublicJobListing {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  description: string;
  schedule_days_hours: string | null;
  worker_profile_sought: string | null;
  service: string | null;
  pathologies: string | null;
  provincia: string | null;
  localidad: string | null;
  neighborhood: string | null;
  detail_link: string;
}

export interface PublicJobListingResponse {
  success: true;
  data: PublicJobListing[];
}
