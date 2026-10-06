/** A versioned opaque record. CAS is atomic for callers in the same JS realm and best effort across tabs. */
export interface Persistence {
 read(): string | null;
 compareAndSwap(expected: string | null, next: string | null): boolean;
 subscribe?(callback: () => void): () => void;
}
/** All platform effects used by the actor. No DOM is required. */
export interface Environment {
 readonly fetch: typeof globalThis.fetch;
 now(): number;
 setTimeout(callback: () => void, milliseconds: number): unknown;
 clearTimeout(handle: unknown): void;
 random(): number;
 readonly visibility?: {
  isVisible(): boolean;
  subscribe(callback: () => void): () => void;
 };
}
/** Creates an isolated memory record. Subscribers observe successful swaps. */
export function memoryPersistence(): Persistence {
 let value: string | null = null;
 const listeners = new Set<() => void>();
 return {
  read: () => value,
  compareAndSwap(expected, next) {
   if (expected !== value) return false;
   if (next === value) return true;
   value = next;
   for (const callback of listeners) { try { callback(); } catch { /* Subscriber exceptions cannot change a committed record. */ } }
   return true;
  },
  subscribe(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
 };
}
export function defaultEnvironment(): Environment {
 const timers = new Map<object, ReturnType<typeof globalThis.setTimeout>>();
 return {
  fetch: globalThis.fetch.bind(globalThis),
  now: Date.now,
  random: Math.random,
  setTimeout(callback, milliseconds) {
   const handle = {};
   const deadline = Date.now() + milliseconds;
   const arm = (): void => {
    const left = deadline - Date.now();
    const timer = globalThis.setTimeout(() => {
     if (deadline > Date.now()) arm();
     else { timers.delete(handle); callback(); }
    }, Math.max(0, Math.min(2_147_483_647, left)));
    timers.set(handle, timer);
   };
   arm();
   return handle;
  },
  clearTimeout(handle) {
   if (typeof handle !== 'object' || handle === null) return;
   const timer = timers.get(handle);
   if (timer !== undefined) { globalThis.clearTimeout(timer); timers.delete(handle); }
  },
 };
}
