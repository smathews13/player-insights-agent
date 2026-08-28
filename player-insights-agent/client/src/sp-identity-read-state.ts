import type { SpIdentityAdminPayload } from '../../shared/sp-identity';
import { EMPTY_SP_IDENTITY } from './identity-settings-api';

export interface SpIdentityReadState {
  payload: SpIdentityAdminPayload;
  hasLastGoodPayload: boolean;
  loading: boolean;
  error: string | null;
}

export const INITIAL_SP_IDENTITY_READ_STATE: SpIdentityReadState = {
  payload: EMPTY_SP_IDENTITY,
  hasLastGoodPayload: false,
  loading: true,
  error: null,
};

export function startSpIdentityRead(state: SpIdentityReadState): SpIdentityReadState {
  return { ...state, loading: true, error: null };
}

export function finishSpIdentityRead(state: SpIdentityReadState, payload: SpIdentityAdminPayload): SpIdentityReadState {
  return { ...state, payload, hasLastGoodPayload: true, loading: false, error: null };
}

export function failSpIdentityRead(state: SpIdentityReadState, error: string): SpIdentityReadState {
  return { ...state, loading: false, error };
}
