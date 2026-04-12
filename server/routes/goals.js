import { Router } from 'express';

export function createGoalsRouter({ goalIntake, planner, jobLifecycle }) {
  const router = Router();

  router.post('/goals/receive', async (req, res) => {
    const synthetic = {
      type: 'OTM',
      source_organ: req.body.source_organ || 'Cortex',
      target_organ: 'Thalamus',
      reply_to: req.body.reply_to || 'Cortex',
      message_id: `urn:llm-ops:otm:http-${Date.now()}`,
      payload: { event_type: 'autonomous_goal', ...req.body },
    };
    const result = await goalIntake(synthetic);
    if (!result.handled) return res.status(400).json(result);
    if (result.job_urn) {
      const job = jobLifecycle.getJob(result.job_urn);
      if (job) planner.planAndDispatch(job).catch(() => {});
    }
    res.status(201).json({
      job_id: result.job_urn,
      status: 'received',
      lane: 'pending',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
