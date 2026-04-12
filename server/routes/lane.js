import { Router } from 'express';

export function createLaneRouter({ laneSelector, jobLifecycle }) {
  const router = Router();

  router.get('/lane/select', (req, res) => {
    const { job_id, phase } = req.query;
    if (!job_id) return res.status(400).json({ error: 'missing_job_id' });
    const job = jobLifecycle.getJob(job_id);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    const result = laneSelector.selectLane(job, { phase: phase || 'final' });
    res.json(result);
  });

  return router;
}
