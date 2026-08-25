// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Own the AbortController for a "latest result wins" request slot.
 *
 * Mailbox navigation already used monotonic tokens to reject stale results,
 * but the obsolete fetches kept consuming FastAPI/SQLite work. This small
 * lifecycle primitive cancels that work at the source while the tokens remain
 * as the final state-integrity guard.
 */
export class LatestRequest {
  constructor() {
    this.controller = null;
  }

  next() {
    this.cancel('superseded');
    this.controller = new AbortController();
    return this.controller.signal;
  }

  cancel(reason = 'cancelled') {
    const ctrl = this.controller;
    this.controller = null;
    if (ctrl && !ctrl.signal.aborted) ctrl.abort(reason);
  }
}
