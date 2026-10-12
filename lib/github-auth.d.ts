export interface AuthResponse { status: number; headers: Record<string, string>; body: string }
export function handleLogin(req: { origin: string; env: Record<string, string | undefined> }): AuthResponse
export function handleCallback(req: {
  origin: string
  query: Record<string, string | undefined>
  cookies: Record<string, string>
  env: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}): Promise<AuthResponse>
export function parseCookies(header: string | undefined): Record<string, string>
