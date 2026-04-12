import { Router } from 'express';

export function createProposalsRouter({ apDrafter, jobLifecycle }) {
  const router = Router();

  router.post('/proposals/draft', async (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.status(400).json({ error: 'missing_job_id' });
    const job = jobLifecycle.getJob(job_id);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    const result = await apDrafter.draftAP(job);
    res.status(result.submitted ? 201 : 422).json(result);
  });

  return router;
}
