# Thalamus Organ (#230)

## Identity

- **Organ:** Thalamus (Operational Coordination Brain)
- **Number:** 230
- **Profile:** Probabilistic
- **Artifact:** logic (no encapsulated database; lifecycle in spine-state)
- **DIO Node:** B (Orchestrator)
- **Ports:** 4041 (AOS) / 3941 (SAAS)
- **Binding:** 127.0.0.1

## Role

Thalamus is the operational coordination brain of the DIO. It receives goals from Cortex (autonomous, MP-12) and requests from Receptor (human-initiated, MP-14), translates them into governed executable work, drafts Action Proposals (APs) for the write lane, dispatches reads directly for the R0 lane, and routes ATMs from Nomos to Cerberus for execution.

Thalamus answers exactly one question: **"How should this be done?"** This is fundamentally different from Cortex's question ("What should the organism do next?") and from Nomos's question ("Is this allowed?"). The separation of strategic assessment from operational coordination from judicial authority prevents a god organ.

Thalamus is the **sole producer of APMs.** No other organ may draft Action Proposals. Nomos verifies `source_organ === 'Thalamus'` on every incoming APM (verified in `AOS-organ-nomos-src/handlers/spine-commands.js`).

Thalamus is the **routing intermediary for ATMs** from Nomos to Cerberus. ATM flow: Nomos -> Thalamus -> Cerberus. Thalamus does not validate or consume the token -- it enriches the ATM with `payload.execution_request` (rehydrated from the JobRecord at AP-draft time) and forwards. Cerberus's `atm-handler.js` rejects any ATM whose `source_organ !== 'Thalamus'`.

## Boundary (binding)

- **Thalamus produces APMs and consumes/routes ATMs.** Per architectural-conclusions S1: Thalamus is the only organ in the matrix that **produces** APM and **routes** ATM. Thalamus is also a normal P/C OTM participant.
- **Thalamus does NOT execute writes.** Cerberus holds the Key Monopoly. Thalamus never holds write credentials. Even for R0 reads, Thalamus only orchestrates -- the actual reads run against department organ HTTP endpoints.
- **Thalamus has read-only access to Graphheight** via the Graph adapter (911 -> 311 path). Read-only -- never writes.
- **Thalamus reads MSP + BoR raw text as constitutional conditioning** for its Sonnet AP drafter (per the 2026-04-11 amendment to MP-13 -- Cortex role audit Finding 1 resolution). It does NOT make scope rulings. IN_SCOPE / OUT_OF_SCOPE / AMBIGUOUS determinations belong to Arbiter at Nomos -> Arbiter adjudication. The drafter prompt is mechanically guarded against scope-ruling language by a CV test (relay t3q-8).

## Dependencies

| Organ | AOS Port | Purpose | Hardness |
|---|---|---|---|
| Spine | 4000 | Message bus + spine-state job lifecycle | hard |
| Nomos | 4022 | APM target / ATM source | soft (degraded: write-lane jobs queue, R0 jobs continue) |
| Cerberus | 4023 | ATM forwarding target (Thalamus -> Cerberus) | soft (degraded: dispatched ATMs queued and retried) |
| Graph | 4020 | MSP raw text (`msp_version` concept), graph-augmented context, structural identity | soft (degraded: MSP frame absent, graph-augmented context skipped, AP draft proceeds with flagged degraded list) |
| Arbiter | 4021 | BoR raw text via `GET /bor/raw` | soft (degraded: BoR frame absent, AP draft proceeds with MSP only + flagged) |
| Radiant | 4006 | CM evidence -- context + memory blocks | soft |
| Minder | 4007 | CM evidence -- person observations | soft |
| Hippocampus | 4008 | CM evidence -- recent conversation summaries | soft |
| Syntra | 4011 | CM evidence -- semantic search | soft |
| ModelBroker | 4042 | LLM inference routing (MP-14 -- currently absent) | absent: Thalamus uses `createLLMClient` directly until MP-14 lands |
| Cortex | 4040 | Goal source (OTM consumer pattern) | observed via Spine, no direct HTTP |
| Receptor | 4050 | Request source (MP-14 -- currently absent) | observed via Spine, no direct HTTP |

**`createOrgan` dependencies list:** `['Spine']` only. All other organs are soft -- probed at boot but Thalamus proceeds with degraded flags. If Spine itself is unreachable, the organ refuses to start (shared-lib organ-boot.js dependency check).

## Key Modules

- `@coretex/organ-boot` -- boot factory (`createOrgan`)
- `@coretex/organ-boot/urn` -- URN generation (`urn:llm-ops:<ns>:<ts>-<rand>`)
- `@coretex/organ-boot/spine-client` -- Spine WebSocket + HTTP client
- `@coretex/organ-boot/llm-client` -- Sonnet client for AP drafting
- `lib/spine-state-client.js` -- HTTP client for spine-state job entities (relay t3q-1)
- `lib/job-store.js` -- in-memory JobRecord cache (relay t3q-1)
- `lib/job-lifecycle.js` -- write-through lifecycle controller (relay t3q-1)
- `lib/spine-proxy.js` -- pre-live spine reference (relay t3q-1)
- `lib/goal-intake.js` -- Cortex goal handler (relay t3q-2)
- `lib/request-intake.js` -- Receptor request handler (relay t3q-2)
- `lib/mission-loader.js` -- MSP + BoR constitutional conditioning loader (relay t3q-3)
- `lib/ap-drafter.js` -- Sonnet AP drafter (relay t3q-3)
- `lib/lane-selector.js` -- deterministic R0/write classifier (relay t3q-4)
- `lib/graph-context.js` -- read-only Graphheight context enrichment (relay t3q-5)
- `lib/dispatcher.js` -- execution dispatch + ATM enrichment (relay t3q-6)
- `handlers/spine-commands.js` -- directed message router (relay t3q-7)
- `handlers/broadcast.js` -- broadcast handler (relay t3q-7)

## Architecture

Thalamus is a coordinator. It does not run a continuous loop of its own; it reacts to Spine messages.

**Inbound message flows:**
- **Cortex goal (OTM, `event_type: autonomous_goal`)** -> Job CREATED -> PLANNING -> lane selection -> either R0 dispatch OR AP draft -> AWAITING_AUTH -> ATM -> DISPATCHED -> EXECUTING -> SUCCEEDED|FAILED
- **Receptor request (OTM, `event_type: ingress_request`)** -> same lifecycle, but `source = 'receptor'`
- **Nomos ATM (Authorized / Authorized-with-Conditions)** -> ATM enriched with `execution_request` -> forwarded to Cerberus
- **Nomos OTM (`adjudication_result`, `adjudication_held`, `apm_rejected`)** -> job moves to DENIED, or evidence-request loop, or DISPATCHED depending on ruling
- **Cerberus OTM (`execution_completed` broadcast, `execution_denied` broadcast)** -> job marked SUCCEEDED or FAILED accordingly
- **Department organ OTM (R0 read response)** -> job marked SUCCEEDED with result attached

**Outbound message flows:**
- **APM -> Nomos** (write-lane jobs only -- Thalamus is the sole APM producer)
- **ATM (forwarded) -> Cerberus** (ATM enriched with `execution_request` from JobRecord)
- **OTM -> originator (Cortex or Receptor)** with lifecycle acks: `job_record_created`, `job_dispatched`, `job_completed`, `job_failed`. Cortex's directed handler is wired to consume all four (verified in `AOS-organ-cortex-src/handlers/spine-commands.js` x2p-6 O2 expansion).
- **OTM -> department organs** for R0 read instructions (event_type `r0_read_request`) -- see relay t3q-6 for the architectural deviation note
- **OTM -> Vigil** for organ exception broadcasts (`organ_unavailable`, `nomos_unreachable`, etc.)

**Job lifecycle (spine-state machine, pre-baked in `AOS-organ-spine-src/server/state/definitions.js`):**

```
CREATED -> PLANNING -> AWAITING_AUTH -> DISPATCHED -> EXECUTING -> SUCCEEDED
                   \-> DISPATCHED                              \-> FAILED
                                   \-> DENIED
```

PLANNING can transition directly to DISPATCHED for R0 jobs (bypassing AWAITING_AUTH), or to AWAITING_AUTH for write jobs. DENIED is reachable only from AWAITING_AUTH (Nomos ruling). The state machine is enforced server-side by spine-state -- invalid transitions are 409 rejected.

## Running

```bash
npm install                  # Install dependencies
npm test                     # Run unit tests (no Spine required for the lifecycle tests; spine-state-client tests use a fake HTTP server)
THALAMUS_PORT=4041 npm start # Start organ (requires Spine; all other deps soft)
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith packages
- Never produce PEM, HOM (Thalamus is APM-producer / ATM-router / OTM P-C only)
- Never validate or consume ATM tokens (route-only -- Cerberus consumes)
- Never write to Graphheight (read-only via 911 -> 311)
- Never read BoR file directly from disk -- always via Arbiter `GET /bor/raw`

## Conventions

- ES modules (import/export)
- Node.js built-in test runner (`node --test`)
- Structured JSON logging to stdout
- Express 5 (via organ-shared-lib)
- `/opt/homebrew/bin/node` in LaunchAgent (bug #6)
- LaunchAgent `RunAtLoad: false` (bug #7)
- `createLLMClient(configObject)` direct call with `agentName`/`defaultModel`/`defaultProvider`/`apiKeyEnvVar`/`maxTokens` (bug #8)
- `healthCheck` / `introspectCheck` return flat objects (bug #9)

## Completed Relays

- Relay 1 (t3q-1): Project scaffold + JobRecord lifecycle adapter (spine-state-client, job-store, job-lifecycle, spine-proxy, http-helpers). 7 stub interface files. Unit tests for lifecycle, job-store, spine-state-client.
- Relay 2 (t3q-2): Goal intake (Cortex consumer) + Request intake (Receptor consumer) + lifecycle-ack-emitter + intake-router. job-lifecycle extended with enrichIntakeContext. JobRecord shape extended with mission_ref, assessment_context, intake_context. Unit tests for goal-intake, request-intake, lifecycle-ack-emitter, intake-router.
- Relay 3 (t3q-3): Mission loader + AP drafter (Sonnet) + APM composition + APM submission. graph-adapter, arbiter-client, cm-evidence-client, agents/ap-drafter-agent.js (scope-ruling-free system prompt), lib/ap-drafter.js (fail-closed orchestrator). Unit tests for all 6 new modules including 3-layer scope-ruling discipline binding test.
- Relay 4 (t3q-4): Lane selection — deterministic R0 vs write classifier. config/action-classifier.json (42 actions), lib/lane-selector.js (two-phase: Phase A heuristic + Phase B target-based). job-lifecycle extended with setLane. ap-drafter integrated with lane selector (rejects R0-only APs). Unit tests for lane-selector + drafter lane integration.
- Relay 5 (t3q-5): Graphheight read-only integration. graph-adapter extended with getBindings/traverseFrom/getConceptsByType. lib/urn-seeds.js (URN seed extractor). lib/graph-context.js (full enricher replacing stub). ap-drafter wired with real graphContext. SQL uses class_bindings with data.from_urn/data.to_urn (no dedicated /bindings endpoint on Graph organ).
- Relay 6 (t3q-6): Execution dispatch. lib/atm-forwarder.js (ATM enrichment + Cerberus forward), lib/r0-dispatcher.js (direct HTTP R0 — architectural deviation, Spine OTM broadcasts for observability), lib/dispatcher.js (full orchestrator replacing stub — write/R0 dispatch + Nomos ruling consumers + Cerberus broadcast consumers), handlers/nomos-atm.js + handlers/cerberus-broadcast.js. config/r0-action-endpoints.json (27 R0 actions). server/config.js patched with 9 department organ URLs. State machine fix: AWAITING_AUTH -> DENIED (not FAILED) for APM rejection and ATM forwarding failure.
- Relay 7 (t3q-7): Spine integration — full createOrgan boot. lib/planner.js (post-intake orchestrator with R0 fast-path + AP drafting). lib/health-probes.js (flat healthCheck/introspectCheck per bug #9). handlers/spine-commands.js (directed message handler — intake/Nomos/ATM/health/non-consumer rejection). handlers/broadcast.js (mission invalidation + Cerberus broadcast routing). 6 route files (goals/requests/jobs/proposals/dispatch/lane). server/index.js full boot replacing stub. LaunchAgent plist (bug #6 + bug #7). Thalamus is npm-start-ready.
- Relay 8 (t3q-8): CV tests + closeout. 12 CV test files (44 tests) including BINDING cv-scope-ruling-prompt-discipline, inverse Cortex contract lock, Cerberus ATM contract lock, write-lane/R0-lane end-to-end, Nomos denial handling, Cerberus broadcast consumption, live-loop health. Vigil registry thalamus group registered. Organ registry #230 marked active. Migration checklist MP-13 ticked. Git init + first commit.
