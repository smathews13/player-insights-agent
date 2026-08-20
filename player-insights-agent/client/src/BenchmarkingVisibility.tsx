import type { ReactNode } from 'react';
import { Navigate, useOutletContext } from 'react-router';
import type { ExperimentalFeaturesHandle } from './app-types';
import { showsBenchmarkLab } from './experimental-features';
import { BENCHMARK_LAB_ENABLED } from './nav-reveal';

/** Uses the same live preference for the route body as the main navigation. */
export function BenchmarkingVisibility({ children }: { children: ReactNode }) {
  const { features } = useOutletContext<ExperimentalFeaturesHandle>();
  if (!BENCHMARK_LAB_ENABLED || !showsBenchmarkLab(features)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
