export interface WorkerTag {
  id: string;
  name: string;
  color: string; // "#RRGGBB"
  description?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerTagSummary {
  id: string;
  name: string;
  color: string;
  description?: string;
}
