/** One concise timing for startup handoff and top-level page changes. */
export const SURFACE_TRANSITION_MS = 180;

export interface MotionPreference {
  animations: 'on' | 'off';
  reducedMotion: boolean;
}

/** Explicit Animations Off and the operating-system preference are equal vetoes. */
export function motionRuns({ animations, reducedMotion }: MotionPreference): boolean {
  return animations === 'on' && !reducedMotion;
}

/** Read the preference at the interaction that would start motion. */
export function browserMotionRuns(): boolean {
  try {
    const animations = document.documentElement.dataset.animations === 'off' ? 'off' : 'on';
    const reducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return motionRuns({ animations, reducedMotion });
  } catch {
    return false;
  }
}

export type LoginHandoffStage = 'gate' | 'waiting-for-shell' | 'leaving' | 'open';

export interface LoginHandoff {
  stage: LoginHandoffStage;
  generation: number;
}

export function initialLoginHandoff(open: boolean): LoginHandoff {
  return { stage: open ? 'open' : 'gate', generation: 0 };
}

/**
 * A login action can request entry before Ask is ready, but cannot begin fading.
 * The generation makes completion from an older request harmless.
 */
export function requestLoginHandoff(
  current: LoginHandoff,
  options: { shellReady: boolean; animate: boolean }
): LoginHandoff {
  if (current.stage !== 'gate') return current;
  const generation = current.generation + 1;
  if (!options.shellReady) return { stage: 'waiting-for-shell', generation };
  return { stage: options.animate ? 'leaving' : 'open', generation };
}

export function readyLoginHandoff(current: LoginHandoff, animate: boolean): LoginHandoff {
  if (current.stage !== 'waiting-for-shell') return current;
  return { ...current, stage: animate ? 'leaving' : 'open' };
}

export function completeLoginHandoff(current: LoginHandoff, generation: number): LoginHandoff {
  if (current.stage !== 'leaving' || current.generation !== generation) return current;
  return { ...current, stage: 'open' };
}

/** Called only after the gate has unmounted and released its inert background. */
export function focusAfterLogin(target: (() => void) | null): void {
  target?.();
}

export const ROUTE_ENTER_KEYFRAMES: Keyframe[] = [
  { opacity: 0.72, transform: 'translateY(2px)' },
  { opacity: 1, transform: 'none' },
];

export const ROUTE_ENTER_OPTIONS: KeyframeAnimationOptions = {
  duration: SURFACE_TRANSITION_MS,
  easing: 'ease-out',
};

export interface RouteAnimationTarget {
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
}

/** The returned cleanup cancels a superseded pathname before a newer one starts. */
export function startRouteEnter(target: RouteAnimationTarget | null, animate: boolean): (() => void) | undefined {
  if (!target?.animate || !animate) return;
  const animation = target.animate(ROUTE_ENTER_KEYFRAMES, ROUTE_ENTER_OPTIONS);
  return () => animation.cancel();
}
