export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export async function api<T>(path: string, data?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error ?? 'Сервер недоступен. Попробуйте снова.', body.code);
  return body as T;
}
