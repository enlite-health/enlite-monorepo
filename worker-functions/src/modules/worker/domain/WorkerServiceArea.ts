export interface WorkerServiceArea {
  id: string;
  workerId: string;
  address: string;
  addressComplement?: string;
  serviceRadiusKm: number;
  lat: number;
  lng: number;
  city?: string;
  postalCode?: string;
  neighborhood?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateServiceAreaDTO {
  workerId: string;
  address: string;
  /** undefined = manter o gravado (só em replaceByWorkerId); null/'' = apagar. */
  addressComplement?: string | null;
  serviceRadiusKm: number;
  lat: number;
  lng: number;
  city?: string;
  postalCode?: string;
  neighborhood?: string;
}
