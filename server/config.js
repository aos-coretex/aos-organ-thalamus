/**
 * Thalamus configuration — environment-driven, AOS/SAAS aware.
 *
 * Mirrors Cortex's config layout. LLM config uses shared-lib field names per
 * systemic bug #8. All dependency URLs are direct HTTP — soft deps probed at
 * boot but the organ proceeds with degraded flags if any are unreachable.
 */

const env = process.env.NODE_ENV || 'development';
const isAOS = env !== 'production';

export default {
  name: 'Thalamus',
  port: parseInt(process.env.THALAMUS_PORT || (isAOS ? '4041' : '3941'), 10),
  binding: '127.0.0.1',

  // Spine (hard dep)
  spineUrl: process.env.SPINE_URL || (isAOS ? 'http://127.0.0.1:4000' : 'http://127.0.0.1:3900'),

  // Governance organs (soft deps — write-lane queues, R0 continues)
  nomosUrl:    process.env.NOMOS_URL    || (isAOS ? 'http://127.0.0.1:4022' : 'http://127.0.0.1:3922'),
  cerberusUrl: process.env.CERBERUS_URL || (isAOS ? 'http://127.0.0.1:4023' : 'http://127.0.0.1:3923'),

  // Constitutional + structural reads (soft deps)
  graphUrl:   process.env.GRAPH_URL   || (isAOS ? 'http://127.0.0.1:4020' : 'http://127.0.0.1:3920'),
  arbiterUrl: process.env.ARBITER_URL || (isAOS ? 'http://127.0.0.1:4021' : 'http://127.0.0.1:3921'),

  // Collective Memory (soft deps — degrade gracefully)
  radiantUrl:     process.env.RADIANT_URL     || (isAOS ? 'http://127.0.0.1:4006' : 'http://127.0.0.1:3906'),
  minderUrl:      process.env.MINDER_URL      || (isAOS ? 'http://127.0.0.1:4007' : 'http://127.0.0.1:3907'),
  hippocampusUrl: process.env.HIPPOCAMPUS_URL || (isAOS ? 'http://127.0.0.1:4008' : 'http://127.0.0.1:3908'),
  syntraUrl:      process.env.SYNTRA_URL      || (isAOS ? 'http://127.0.0.1:4011' : 'http://127.0.0.1:3911'),

  // Department organs (soft deps — used by R0 dispatcher, degrade gracefully)
  engramUrl:      process.env.ENGRAM_URL      || (isAOS ? 'http://127.0.0.1:4035' : 'http://127.0.0.1:3935'),
  vectrUrl:       process.env.VECTR_URL       || (isAOS ? 'http://127.0.0.1:4001' : 'http://127.0.0.1:3901'),
  vigilUrl:       process.env.VIGIL_URL       || (isAOS ? 'http://127.0.0.1:4015' : 'http://127.0.0.1:3915'),
  sourcegraphUrl: process.env.SOURCEGRAPH_URL || (isAOS ? 'http://127.0.0.1:4032' : 'http://127.0.0.1:3932'),
  safevaultUrl:   process.env.SAFEVAULT_URL   || (isAOS ? 'http://127.0.0.1:4017' : 'http://127.0.0.1:3917'),
  soulUrl:        process.env.SOUL_URL        || (isAOS ? 'http://127.0.0.1:4009' : 'http://127.0.0.1:3909'),
  gitsyncUrl:     process.env.GITSYNC_URL     || (isAOS ? 'http://127.0.0.1:4030' : 'http://127.0.0.1:3930'),
  promoteUrl:     process.env.PROMOTE_URL     || (isAOS ? 'http://127.0.0.1:4031' : 'http://127.0.0.1:3931'),
  lobeUrl:        process.env.LOBE_URL        || (isAOS ? 'http://127.0.0.1:4010' : 'http://127.0.0.1:3910'),

  // R0 action endpoints table
  r0EndpointsPath: './config/r0-action-endpoints.json',

  // Per-call HTTP timeouts
  cmQueryTimeoutMs:    parseInt(process.env.THALAMUS_CM_TIMEOUT_MS    || '5000', 10),
  graphTimeoutMs:      parseInt(process.env.THALAMUS_GRAPH_TIMEOUT_MS || '3000', 10),
  spineStateTimeoutMs: parseInt(process.env.THALAMUS_SPINE_STATE_TIMEOUT_MS || '3000', 10),

  // Dependency probe interval (mirrors Cortex's §6.1 pattern)
  dependencyProbeIntervalMs: parseInt(process.env.THALAMUS_DEPENDENCY_PROBE_INTERVAL_MS || '60000', 10),

  // Mission cache TTL — fallback when msp_updated / bor_updated broadcasts are missing
  missionCacheTtlMs: parseInt(process.env.THALAMUS_MISSION_TTL_MS || '600000', 10), // 10min

  // LLM settings root (consumed by `@coretex/organ-boot/llm-settings-loader`).
  // MP-CONFIG-1 R5 (l9m-5): no hardcoded model strings; YAML at
  // `01-Organs/230-Thalamus/thalamus-organ-{default,ap-drafter}-llm-settings.yaml`.
  settingsRoot: process.env.SETTINGS_ROOT || `${process.env.VAULT_ROOT || '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops'}/01-Organs`,

  // Action classifier — populated in relay t3q-4
  actionClassifierPath: './config/action-classifier.json',

  // Dependencies passed to createOrgan — Spine only
  dependencies: ['Spine'],

  env,
};
