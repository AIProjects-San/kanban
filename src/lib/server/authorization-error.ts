// Authorization failure marker shared by every server tier.
//
// Lives in lib (not server-actions) so lib kernels — hierarchy, validation,
// the payroll core — can throw it without importing the action layer; the
// actions re-export it through auth-guard.ts.

export class AuthorizationError extends Error {
  /** Stable marker preserved across the server→client boundary so clients can
   * recognise authorisation failures even when production masks messages. */
  readonly digest = "AuthorizationError";

  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}
