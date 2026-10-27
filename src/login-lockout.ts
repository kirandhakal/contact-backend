export interface LoginState { failures: number; level: number; lockedUntil: number }

export async function checkLogin(state: LoginState, verify: () => Promise<boolean>, now = Date.now()) {
  if (state.lockedUntil > now) return { allowed: false, retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000) };
  if (await verify()) {
    state.failures = 0; state.level = 0; state.lockedUntil = 0;
    return { allowed: true, retryAfterSeconds: 0 };
  }
  state.failures++;
  if (state.failures < 5) return { allowed: false, retryAfterSeconds: 0 };
  const seconds = Math.min(86400, 60 * 5 ** state.level);
  state.failures = 0;
  state.level = Math.min(5, state.level + 1);
  state.lockedUntil = now + seconds * 1000;
  return { allowed: false, retryAfterSeconds: seconds };
}
