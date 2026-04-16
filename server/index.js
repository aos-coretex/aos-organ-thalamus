/**
 * Thalamus (#230) — Operational Coordination Brain
 *
 * Full createOrgan boot wiring. Assembles all components from t3q-1 through
 * t3q-6 and boots the organ via the shared-lib factory.
 *
 * Boot sequence:
 *  1. Load config + classifier + R0 endpoints tables
 *  2. Probe soft dependencies
 *  3. Instantiate adapters + stores + readers + controllers
 *  4. Instantiate handlers
 *  5. Boot organ via createOrgan
 */

import config from './config.js';
import { createOrgan } from '@coretex/organ-boot';
import { createLoader } from '@coretex/organ-boot/llm-settings-loader';
import { initializeUsageAttribution } from '@coretex/organ-boot/usage-attribution';

import { createGraphAdapter } from '../lib/graph-adapter.js';
import { createArbiterClient } from '../lib/arbiter-client.js';
import { createSpineStateClient } from '../lib/spine-state-client.js';
import { createSpineProxy } from '../lib/spine-proxy.js';
import { createJobStore } from '../lib/job-store.js';
import { createMissionLoader } from '../lib/mission-loader.js';
import { createCmEvidenceClient } from '../lib/cm-evidence-client.js';
import { createGraphContext } from '../lib/graph-context.js';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createLifecycleAckEmitter } from '../lib/lifecycle-ack-emitter.js';
import { createGoalIntake } from '../lib/goal-intake.js';
import { createRequestIntake } from '../lib/request-intake.js';
import { createIntakeRouter } from '../lib/intake-router.js';
import { createAPDrafter } from '../lib/ap-drafter.js';
import { createLaneSelector, loadClassifierTable } from '../lib/lane-selector.js';
import { createAtmForwarder } from '../lib/atm-forwarder.js';
import { createR0Dispatcher, loadR0EndpointsTable } from '../lib/r0-dispatcher.js';
import { createDispatcher } from '../lib/dispatcher.js';
import { createPlanner } from '../lib/planner.js';
import { createNomosAtmHandler } from '../handlers/nomos-atm.js';
import { createCerberusBroadcastHandler } from '../handlers/cerberus-broadcast.js';
import { createDirectedHandler } from '../handlers/spine-commands.js';
import { createBroadcastHandler } from '../handlers/broadcast.js';
import { buildHealthCheck, buildIntrospectCheck } from '../lib/health-probes.js';
import { timedFetch } from '../lib/http-helpers.js';

import { createGoalsRouter } from './routes/goals.js';
import { createRequestsRouter } from './routes/requests.js';
import { createJobsRouter } from './routes/jobs.js';
import { createProposalsRouter } from './routes/proposals.js';
import { createDispatchRouter } from './routes/dispatch.js';
import { createLaneRouter } from './routes/lane.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// --- Soft-dep probes ---

async function probeHttp(url, name) {
  const res = await timedFetch(`${url}/health`, { timeoutMs: 2000 });
  log('thalamus_probe', { organ: name, reachable: res.ok, status: res.status, error: res.error });
  return res.ok;
}

const probes = {};

async function probeAllDependencies() {
  probes.spine_state = await probeHttp(config.spineUrl, 'Spine');
  probes.nomos       = await probeHttp(config.nomosUrl, 'Nomos');
  probes.cerberus    = await probeHttp(config.cerberusUrl, 'Cerberus');
  probes.graph       = await probeHttp(config.graphUrl, 'Graph');
  probes.arbiter     = await probeHttp(config.arbiterUrl, 'Arbiter');
  probes.radiant     = await probeHttp(config.radiantUrl, 'Radiant');
  probes.minder      = await probeHttp(config.minderUrl, 'Minder');
  probes.hippocampus = await probeHttp(config.hippocampusUrl, 'Hippocampus');
  probes.syntra      = await probeHttp(config.syntraUrl, 'Syntra');
}

await probeAllDependencies();

let probeTimer = null;

// --- Load static tables ---

const classifierTable = await loadClassifierTable(config.actionClassifierPath);
const r0EndpointsTable = await loadR0EndpointsTable(config.r0EndpointsPath);

// --- Component instantiation ---

const spineProxy = createSpineProxy();

const graphAdapter = createGraphAdapter({ graphUrl: config.graphUrl, timeoutMs: config.graphTimeoutMs });
const arbiterClient = createArbiterClient({ arbiterUrl: config.arbiterUrl, timeoutMs: config.cmQueryTimeoutMs });
const spineStateClient = createSpineStateClient({ spineUrl: config.spineUrl, timeoutMs: config.spineStateTimeoutMs });

const jobStore = createJobStore({ limit: 1000 });
const jobLifecycle = createJobLifecycle({ spineStateClient, jobStore });

const missionLoader = createMissionLoader({
  graphAdapter, arbiterClient, cacheTtlMs: config.missionCacheTtlMs,
});
const cmEvidenceClient = createCmEvidenceClient({
  radiantUrl: config.radiantUrl,
  minderUrl: config.minderUrl,
  hippocampusUrl: config.hippocampusUrl,
  syntraUrl: config.syntraUrl,
  timeoutMs: config.cmQueryTimeoutMs,
});
const graphContext = createGraphContext({ graphAdapter });

const lifecycleAckEmitter = createLifecycleAckEmitter({ spine: spineProxy });

const laneSelector = createLaneSelector({ table: classifierTable });

// MP-CONFIG-1 R5 migration (l9m-5) — LLM settings loader.
const llmLoader = createLoader({
  organNumber: 230,
  organName: 'thalamus',
  settingsRoot: config.settingsRoot,
});

// MP-CONFIG-1 R9 — register the process-default usage writer.
initializeUsageAttribution({ organName: 'Thalamus', graphUrl: config.graphUrl });
const { config: apDrafterLlmConfig, chat: apDrafterChat } = llmLoader.resolveWithCascade('ap-drafter');
const apDrafterApiKeyEnv = apDrafterLlmConfig.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
const apDrafterLlmClient = {
  chat: apDrafterChat,
  isAvailable: () => Boolean(process.env[apDrafterApiKeyEnv]),
  getUsage: () => ({ agent: apDrafterLlmConfig.agentName, model: apDrafterLlmConfig.defaultModel, provider: apDrafterLlmConfig.defaultProvider }),
};

const apDrafterInstance = createAPDrafter({
  llmConfig: apDrafterLlmConfig,  // legacy field — preserved for any consumer reading maxTokens via config
  injectedLlm: apDrafterLlmClient,  // boot path supplies the loader-derived client
  missionLoader,
  cmEvidenceClient,
  graphContext,
  spine: spineProxy,
  jobLifecycle,
  laneSelector,
});

const atmForwarder = createAtmForwarder({ spine: spineProxy, jobLifecycle });

const r0Dispatcher = createR0Dispatcher({
  endpointsTable: r0EndpointsTable,
  organUrls: {
    radiantUrl: config.radiantUrl,
    minderUrl: config.minderUrl,
    hippocampusUrl: config.hippocampusUrl,
    syntraUrl: config.syntraUrl,
    graphUrl: config.graphUrl,
    engramUrl: config.engramUrl,
    vectrUrl: config.vectrUrl,
    vigilUrl: config.vigilUrl,
    sourcegraphUrl: config.sourcegraphUrl,
    safevaultUrl: config.safevaultUrl,
    soulUrl: config.soulUrl,
    gitsyncUrl: config.gitsyncUrl,
    promoteUrl: config.promoteUrl,
    lobeUrl: config.lobeUrl,
  },
  timeoutMs: config.cmQueryTimeoutMs,
});

const dispatcher = createDispatcher({
  jobLifecycle,
  atmForwarder,
  r0Dispatcher,
  lifecycleAckEmitter,
});

const planner = createPlanner({ jobLifecycle, laneSelector, apDrafter: apDrafterInstance, dispatcher });

const goalIntake = createGoalIntake({ jobLifecycle, lifecycleAckEmitter });
const requestIntake = createRequestIntake({ jobLifecycle, lifecycleAckEmitter });
const intakeRouter = createIntakeRouter({ goalIntake, requestIntake });

const nomosAtmHandler = createNomosAtmHandler({ dispatcher });
const cerberusBroadcastHandler = createCerberusBroadcastHandler({ dispatcher });

const directedHandler = createDirectedHandler({
  intakeRouter,
  planner,
  dispatcher,
  nomosAtmHandler,
  jobLifecycle,
});

const broadcastHandler = createBroadcastHandler({
  missionLoader,
  cerberusBroadcastHandler,
});

// --- Boot organ ---

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,
  dependencies: config.dependencies,

  routes: (app) => {
    app.use(createGoalsRouter({ goalIntake, planner, jobLifecycle }));
    app.use(createRequestsRouter({ requestIntake, planner, jobLifecycle }));
    app.use(createJobsRouter({ jobLifecycle }));
    app.use(createProposalsRouter({ apDrafter: apDrafterInstance, jobLifecycle }));
    app.use(createDispatchRouter({ dispatcher, jobLifecycle }));
    app.use(createLaneRouter({ laneSelector, jobLifecycle }));
  },

  onMessage: directedHandler,
  onBroadcast: broadcastHandler,

  subscriptions: [
    { event_type: 'msp_updated' },
    { event_type: 'bor_updated' },
    { event_type: 'governance_version_activated' },
    { event_type: 'execution_completed' },
    { event_type: 'execution_denied' },
    { event_type: 'execution_failed' },
    { event_type: 'state_transition' },
    { event_type: 'mailbox_pressure' },
  ],

  healthCheck: buildHealthCheck({
    probes,
    jobStore,
    missionLoader,
    llm: apDrafterInstance.draftAP?.llm,
  }),

  introspectCheck: buildIntrospectCheck({
    jobStore,
    missionLoader,
    dependencies: config.dependencies,
    llmLoader,
  }),

  onStartup: async ({ spine }) => {
    spineProxy.bind(spine);
    log('thalamus_spine_bound', { spine_url: config.spineUrl });

    probeTimer = setInterval(() => {
      probeAllDependencies().catch((err) =>
        log('thalamus_dependency_probe_error', { error: err.message }),
      );
    }, config.dependencyProbeIntervalMs);
    if (probeTimer.unref) probeTimer.unref();

    try {
      const resumed = await spineStateClient.listNonTerminalJobs();
      log('thalamus_jobs_resumed', { count: resumed.length });
    } catch (err) {
      log('thalamus_jobs_resume_failed', { error: err.message });
    }
  },

  onShutdown: async () => {
    log('thalamus_shutting_down', { total_jobs: jobStore.stats().total });
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
    jobStore.clear();
  },
});

log('thalamus_ready', { port: config.port, profile: 'probabilistic', artifact: 'logic' });
