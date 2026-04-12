import { Router } from 'express';

export function createDispatchRouter({ dispatcher, jobLifecycle }) {
  const router = Router();

  router.post('/dispatch', async (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.status(400).json({ error: 'missing_job_id' });
    const job = jobLifecycle.getJob(job_id);
    if (!job) return res.status(404).json({ error: 'job_not_found' });

    if (job.lane === 'r0') {
      const targets = req.body.targets || ['Radiant:query'];
      const result = await dispatcher.dispatchR0({ jobRecord: job, targets });
      return res.status(result.dispatched ? 200 : 422).json(result);
    }

    if (req.body.atm_envelope) {
      const result = await dispatcher.dispatchWriteAfterAuth({ atmEnvelope: req.body.atm_envelope });
      return res.status(result.dispatched ? 200 : 422).json(result);
    }

    res.status(400).json({ error: 'missing_atm_envelope_for_write_lane' });
  });

  return router;
}
