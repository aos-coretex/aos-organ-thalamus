import { Router } from 'express';

export function createJobsRouter({ jobLifecycle }) {
  const router = Router();

  router.get('/jobs', (req, res) => {
    const { status, source, limit } = req.query;
    const jobs = jobLifecycle.listJobs({
      status: status || null,
      source: source || null,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json({ jobs, count: jobs.length });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = jobLifecycle.getJob(decodeURIComponent(req.params.id));
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    res.json(job);
  });

  return router;
}
