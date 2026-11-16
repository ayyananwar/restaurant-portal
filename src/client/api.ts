export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    signal: AbortSignal.timeout(8000),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new RequestError(response.status, payload.error ?? 'The request failed.');
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function message(error: unknown) {
  return error instanceof RequestError ? error.message : 'Connection interrupted. Check the restaurant Wi-Fi and try again.';
}
