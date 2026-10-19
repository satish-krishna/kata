import { Injectable } from '@angular/core';
import { toast } from '@spartan-ng/brain/sonner';

const TTL_MS = 6000;

/** Transient error notifications. Sonner owns the list, the timers and dismissal; `<hlm-toaster>` in the app shell renders them. */
@Injectable({ providedIn: 'root' })
export class ToastStore {
  /** Raise a success toast with the same lifetime as an error. */
  success(message: string): string | number {
    return toast.success(message, { duration: TTL_MS });
  }

  /** Raise a neutral note: something the operator should know that is neither a success nor a failure. */
  info(message: string): string | number {
    return toast.info(message, { duration: TTL_MS });
  }

  /** Raise an error toast. Errors are announced assertively, matching the `role="alert"` the old toaster had. */
  error(message: string): string | number {
    return toast.error(message, { duration: TTL_MS, important: true });
  }
}
