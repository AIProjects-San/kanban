// NextAuth type augmentation — add `id` and `role` to the session user
import "next-auth";

declare module "next-auth" {
  interface User {
    id: string;
    role: string;
    // L-P0-8 — session revocation. Returned from authorize() and stamped
    // onto the JWT at sign-in; checked against the DB-side tokenVersion
    // in the jwt callback. A mismatch invalidates the session.
    tokenVersion?: number;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    roleCheckedAt?: number;
    // L-P0-8 — snapshot of the user's tokenVersion at sign-in (and after
    // each periodic refresh). Compared against the DB value to detect
    // revocation (password change / role change).
    tokenVersion?: number;
  }
}
