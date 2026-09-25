import type { ReactNode } from 'react';
import { Navigate, useOutletContext } from 'react-router';

import type { ExperimentalFeaturesHandle } from './app-types';
import { showsContractObservatory } from './experimental-features';

/** Uses the same deployment-wide toggle for the direct route as the navigation. */
export function ContractVisibility({ children }: { children: ReactNode }) {
  const { features } = useOutletContext<ExperimentalFeaturesHandle>();
  if (!showsContractObservatory(features)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
