import { DestroyRef } from '@angular/core';

/**
 * Custom error thrown when an async operation finishes after the component is destroyed.
 */
export class ComponentDestroyedError extends Error {
  constructor() {
    super('Component destroyed');
    this.name = 'ComponentDestroyedError';
  }
}

/**
 * Throws ComponentDestroyedError if the provided DestroyRef is marked as destroyed.
 */
export function checkDestroyed(destroyRef: DestroyRef): void {
  if (destroyRef.destroyed) {
    throw new ComponentDestroyedError();
  }
}

/**
 * Wraps a promise and ensures that if the component is destroyed during the await,
 * a ComponentDestroyedError is thrown to halt execution.
 */
export async function guard<T>(destroyRef: DestroyRef, promise: Promise<T>): Promise<T> {
  const result = await promise;
  checkDestroyed(destroyRef);
  return result;
}

/**
 * Helper to check if an error is a ComponentDestroyedError.
 * Useful in catch blocks to distinguish between real errors and destruction halts.
 */
export function isDestroyedError(error: unknown): error is ComponentDestroyedError {
  return (
    error instanceof ComponentDestroyedError || 
    (error instanceof Error && error.name === 'ComponentDestroyedError')
  );
}