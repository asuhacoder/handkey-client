declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };
export type RequestId = Brand<string, 'RequestId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type Instant = Brand<number, 'Instant'>;

export type SecretName =
  | { readonly kind: 'verified'; readonly vault: string; readonly item: string; readonly field: string; readonly fieldType: string; readonly origins: readonly string[] }
  | { readonly kind: 'unverified'; readonly partial: { readonly vault: string; readonly item: string; readonly field: string } }
  | { readonly kind: 'legacy' };
export interface SecretRef {
  readonly key: string; readonly vaultId: string; readonly itemId: string; readonly fieldId: string; readonly name: SecretName;
}
export interface Binding { readonly name: string; readonly ref: SecretRef | null }
export type TypeTarget =
  | { readonly kind: 'window'; readonly pid: number; readonly app: string; readonly title: string }
  | { readonly kind: 'unparsed'; readonly raw: string };
export interface ItemField { readonly id: string; readonly label: string; readonly type: string }
export type Operation =
  | { readonly kind: 'reveal'; readonly outputFormat: string | null }
  | { readonly kind: 'otp' }
  | { readonly kind: 'exec'; readonly command: readonly string[]; readonly directory: string; readonly env: readonly Binding[]; readonly unmasked: boolean }
  | { readonly kind: 'proxy'; readonly origin: string; readonly header: string; readonly prefix: string; readonly command: readonly string[]; readonly directory: string; readonly env: readonly Binding[] }
  | { readonly kind: 'type'; readonly target: TypeTarget }
  | { readonly kind: 'clipboard' }
  | { readonly kind: 'write'; readonly vaultId: string; readonly vaultName: string | null; readonly title: string; readonly category: string; readonly fields: readonly ItemField[]; readonly passwordRecipe: string | null }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'unrecognized'; readonly raw: string };
export type Lease = { readonly kind: 'single-use' } | { readonly kind: 'window'; readonly seconds: number; readonly maxUses: number };
export type Caution = 'value-reaches-model' | 'output-unmasked' | 'clipboard-persists' | 'values-not-reviewable' | 'names-unverified' | 'long-lease' | 'multiple-uses';
export type Approval =
  | { readonly kind: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' }
  | { readonly kind: 'unrecognized'; readonly raw: string };
export type Execution =
  | { readonly kind: 'not-started' | 'running' | 'ready' | 'succeeded' | 'failed' | 'outcome-unknown' | 'expired' | 'consumed' }
  | { readonly kind: 'unrecognized'; readonly raw: string };
export interface CreatedItem {
  readonly id: string; readonly vaultId: string; readonly vaultName: string | null; readonly title: string;
  readonly urls: readonly string[]; readonly fields: readonly ItemField[]; readonly fieldsKnown: boolean; readonly syncedAt: Instant | null;
}
export interface Request {
  readonly id: RequestId; readonly agent: string | null; readonly reason: string; readonly source: string;
  readonly secrets: readonly SecretRef[]; readonly operation: Operation; readonly lease: Lease; readonly cautions: readonly Caution[];
  readonly createdAt: Instant; readonly deadline: Instant; readonly approval: Approval; readonly execution: Execution;
  readonly approvedAt: Instant | null; readonly approvedBy: string | null; readonly approvedSession: string | null;
  readonly leaseUntil: Instant | null; readonly used: number; readonly receiptUntil: Instant | null; readonly createdItem: CreatedItem | null;
}
export interface SessionSummary {
  readonly sessionId: SessionId; readonly name: string; readonly createdAt: Instant; readonly viewUntil: Instant; readonly current: boolean;
}
export function remaining(deadline: Instant, now: Instant): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
export function byDeadline(a: Request, b: Request): number {
  return a.deadline - b.deadline || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function leaseOf(ttlSeconds: number, uses: number): Lease {
  return ttlSeconds === 0 && uses <= 1 ? { kind: 'single-use' } : { kind: 'window', seconds: ttlSeconds || 900, maxUses: Math.max(1, uses) };
}
export function cautionsOf(operation: Operation, secrets: readonly SecretRef[], lease: Lease): readonly Caution[] {
  const result: Caution[] = [];
  switch (operation.kind) {
    case 'reveal': result.push('value-reaches-model'); break;
    case 'exec': if (operation.unmasked) result.push('output-unmasked'); break;
    case 'clipboard': result.push('clipboard-persists'); break;
    case 'write': result.push('values-not-reviewable'); break;
    case 'otp': case 'proxy': case 'type': case 'refresh': case 'unrecognized': break;
    default: { const exhaustive: never = operation; return exhaustive; }
  }
  if (secrets.some(ref => ref.name.kind !== 'verified')) result.push('names-unverified');
  if (lease.kind === 'window') {
    if (lease.seconds >= 3600) result.push('long-lease');
    if (lease.maxUses > 1) result.push('multiple-uses');
  }
  return result;
}
