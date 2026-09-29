/**
 * In-memory bind registry: Pass ↔ face bindings for Consent Station.
 * Cleared on demo reset/prep.
 */

interface Binding {
  token_id: string;
  bound_at: string;
  track_id?: string;
}

const bindings = new Map<string, Binding>();

export function bindPass(tokenId: string, trackId?: string): Binding {
  const binding: Binding = {
    token_id: tokenId,
    bound_at: new Date().toISOString(),
    track_id: trackId,
  };
  bindings.set(tokenId, binding);
  return binding;
}

export function getBinding(tokenId: string): Binding | null {
  return bindings.get(tokenId) ?? null;
}

export function clearBindings(): void {
  bindings.clear();
}

export function listBindings(): Binding[] {
  return Array.from(bindings.values());
}
