import express, { Request, Response } from 'express';
import cors from 'cors';
import { JobsController } from '@modules/worker';
import { markRouteClass, routeClass } from '@modules/identity/permissions';

const app = express();

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

const jobsController = new JobsController();

// Health check
app.get('/health', routeClass('public'), (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', service: 'jobs-only' });
});

// Jobs API
app.get('/api/jobs', routeClass('public'), (req: Request, res: Response) => {
  jobsController.getJobs(req, res);
});

// Sem chamador medido => `staff` (T003/⚑6). Esta entrada não tem auth nem `requireStaff`, então a marca
// vai direto no handler, pelo helper de marca de classe.
app.post('/api/jobs/refresh', markRouteClass((req: Request, res: Response) => {
  jobsController.refreshJobs(req, res);
}, 'staff'));

const PORT = process.env.PORT || 8081;

app.listen(PORT, () => {
  console.log(`🚀 Jobs API running on port ${PORT}`);
  console.log(`📍 Endpoints:`);
  console.log(`   GET  http://localhost:${PORT}/api/jobs`);
  console.log(`   POST http://localhost:${PORT}/api/jobs/refresh`);
});
