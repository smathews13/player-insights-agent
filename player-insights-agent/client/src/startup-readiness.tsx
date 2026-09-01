/* eslint-disable react-refresh/only-export-components -- startup provider and hook are one contract */
import { createContext, useContext, type ReactNode } from 'react';

export interface StartupReadinessValue {
  markReady: () => void;
  registerFocusTarget: (target: (() => void) | null) => void;
}

const NO_STARTUP_READINESS: StartupReadinessValue = {
  markReady: () => undefined,
  registerFocusTarget: () => undefined,
};

const StartupReadinessContext = createContext<StartupReadinessValue>(NO_STARTUP_READINESS);

export function StartupReadinessProvider({ value, children }: { value: StartupReadinessValue; children: ReactNode }) {
  return <StartupReadinessContext value={value}>{children}</StartupReadinessContext>;
}

export function useStartupReadiness(): StartupReadinessValue {
  return useContext(StartupReadinessContext);
}
