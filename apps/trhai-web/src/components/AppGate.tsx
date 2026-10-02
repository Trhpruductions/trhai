"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { BootScreen, type BootResult } from "./BootScreen";
import { SignInScreen } from "./SignInScreen";
import { apiBaseUrl } from "../lib/api";
import {
  browserStores, chooseGuest, clearGuest, clearStoredAuth, isGuestThisSession, readStoredAuth, signOutRequest,
  writeStoredAuth, type SignedInAccount, type StoredAuth
} from "../lib/auth";
import "./gate.css";

// What stands between opening the app and the dashboard: the loading screen,
// then - unless a saved session is still good, or "continue without an
// account" was already chosen this session - the sign-in screen.
//
// The dashboard is not mounted until the gate opens. Every request it makes
// carries the account's token from the first one, rather than some going out
// anonymous while sign-in was still on screen.

type Stage = "boot" | "signin" | "app";

export type AccountControls = {
  /** The signed-in account, or null when using the app without one. */
  account: SignedInAccount | null;
  signOut: () => Promise<void>;
  /** Back to the sign-in screen, from a session without an account. */
  openSignIn: () => void;
};

const AccountContext = createContext<AccountControls>({
  account: null,
  signOut: async () => {},
  openSignIn: () => {}
});

export function useAccount(): AccountControls {
  return useContext(AccountContext);
}

export function AppGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>("boot");
  const [account, setAccount] = useState<SignedInAccount | null>(null);
  // Bumped on every arrival at the dashboard, so it mounts fresh for whoever
  // is now signed in rather than carrying the last account's state.
  const [visit, setVisit] = useState(0);

  const enter = useCallback((next: SignedInAccount | null) => {
    setAccount(next);
    setVisit((count) => count + 1);
    setStage("app");
  }, []);

  const booted = useCallback((result: BootResult) => {
    const { local, session } = browserStores();
    if (result.sessionExpired) clearStoredAuth(local, session);
    if (result.account) {
      enter(result.account);
      return;
    }
    if (isGuestThisSession(session)) {
      enter(null);
      return;
    }
    setStage("signin");
  }, [enter]);

  const signedIn = useCallback((auth: StoredAuth) => {
    const { local, session } = browserStores();
    writeStoredAuth(local, session, auth);
    enter(auth.account);
  }, [enter]);

  const guest = useCallback(() => {
    chooseGuest(browserStores().session);
    enter(null);
  }, [enter]);

  const signOut = useCallback(async () => {
    const { local, session } = browserStores();
    const current = readStoredAuth(local, session);
    clearStoredAuth(local, session);
    clearGuest(session);
    setAccount(null);
    setStage("signin");
    if (current) await signOutRequest(apiBaseUrl, current.token);
  }, []);

  const openSignIn = useCallback(() => {
    clearGuest(browserStores().session);
    setStage("signin");
  }, []);

  const controls = useMemo(() => ({ account, signOut, openSignIn }), [account, signOut, openSignIn]);

  return (
    <AccountContext.Provider value={controls}>
      {stage === "app" ? <div key={visit} className="gate-app">{children}</div> : null}
      {stage === "boot" ? <BootScreen onReady={booted} /> : null}
      {stage === "signin" ? <SignInScreen onSignedIn={signedIn} onGuest={guest} /> : null}
    </AccountContext.Provider>
  );
}
