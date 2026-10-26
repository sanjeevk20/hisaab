// The user behind the current request. Kept per request (not in a shared variable), so concurrent
// requests from different phones never record each other's name on a bill.
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
export const currentUser = () => requestContext.getStore()?.user ?? null;
