/**
 * Lightweight proxy that lets organ components hold a stable reference to
 * the Spine client BEFORE createOrgan() finishes binding it. Matches the
 * Senate / Cerberus pattern (pre-boot hygiene for components instantiated
 * before the live spine client exists).
 *
 * Usage:
 *   const spineProxy = createSpineProxy();
 *   const goalEmitter = createGoalEmitter({ spine: spineProxy, ... });
 *   const organ = await createOrgan({
 *     onStartup: async ({ spine }) => { spineProxy.bind(spine); ... },
 *     ...
 *   });
 */
export function createSpineProxy() {
  let live = null;
  return {
    bind(spine) { live = spine; },
    isBound() { return live !== null; },
    async send(envelope) {
      if (!live) throw new Error('spine-proxy-not-bound');
      return live.send(envelope);
    },
    // Exposed for lookups and dev logging
    raw() { return live; },
  };
}
