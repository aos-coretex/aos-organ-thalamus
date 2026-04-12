/**
 * URN seed extractor — pulls URNs from a JobRecord that are worth seeding
 * Graph traversal from. Used by graph-context to decide where to start
 * exploring.
 *
 * Cortex jobs surface evidence_refs (already-known graph URNs) and gap_ref
 * (the originating gap concept). Receptor jobs surface payload_urn and
 * intent_urn (both minted by Receptor at ingress). All extracted URNs are
 * deduplicated and string-validated.
 */

export function extractUrnSeeds(jobRecord) {
  if (!jobRecord) return [];
  const seeds = new Set();

  // Evidence refs (both intakes)
  for (const ref of jobRecord.evidence_refs || []) {
    if (typeof ref === 'string' && ref.startsWith('urn:')) seeds.add(ref);
  }

  const ic = jobRecord.intake_context || {};

  // Cortex enrichments
  if (ic.gap_ref && typeof ic.gap_ref === 'string') seeds.add(ic.gap_ref);

  // Receptor enrichments
  if (ic.payload_urn && typeof ic.payload_urn === 'string') seeds.add(ic.payload_urn);
  if (ic.intent_urn && typeof ic.intent_urn === 'string') seeds.add(ic.intent_urn);
  if (ic.user_identity && typeof ic.user_identity === 'string' && ic.user_identity.startsWith('urn:')) {
    seeds.add(ic.user_identity);
  }

  return Array.from(seeds);
}
