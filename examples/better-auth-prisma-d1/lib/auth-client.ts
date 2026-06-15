import { createAuthClient } from "better-auth/react";

// baseURL is inferred from the current origin in the browser.
export const authClient = createAuthClient();
export const { signUp, signIn, signOut, useSession } = authClient;
