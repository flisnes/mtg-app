import type {
  ApiErrorBody,
  AuthResponse,
  MeResponse,
  SnapshotGetResponse,
  SnapshotPutRequest,
  SnapshotPutResponse,
  UserListsResponse,
  UsersResponse,
} from '@mtg/shared';
import { API_URL } from './config.js';

// Thin typed fetch wrapper for the accounts API. Every non-2xx response (and
// network failure) throws an ApiError whose `body.error` is a stable code the
// UI can branch on; `friendlyMessage` is safe to show as-is.

export class ApiError extends Error {
  /** HTTP status; 0 = network failure (offline, server down). */
  status: number;
  body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }

  get friendlyMessage(): string {
    if (this.status === 0) return 'Could not reach the server. Check your connection and try again.';
    return this.body?.message ?? 'Something went wrong on the server. Try again later.';
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // non-JSON error page (proxy, etc.)
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export function register(username: string, password: string, inviteCode: string): Promise<AuthResponse> {
  return request('/register', { method: 'POST', body: { username, password, inviteCode } });
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request('/login', { method: 'POST', body: { username, password } });
}

export function logout(token: string): Promise<{ ok: boolean }> {
  return request('/logout', { method: 'POST', token, body: {} });
}

export function me(token: string): Promise<MeResponse> {
  return request('/me', { token });
}

export function deleteAccount(token: string): Promise<{ ok: boolean }> {
  return request('/account', { method: 'DELETE', token });
}

export function putSnapshot(token: string, body: SnapshotPutRequest): Promise<SnapshotPutResponse> {
  return request('/snapshot', { method: 'PUT', token, body });
}

export function getSnapshot(token: string): Promise<SnapshotGetResponse> {
  return request('/snapshot', { token });
}

export function listUsers(token: string): Promise<UsersResponse> {
  return request('/users', { token });
}

export function getUserLists(token: string, username: string): Promise<UserListsResponse> {
  return request(`/users/${encodeURIComponent(username)}/lists`, { token });
}
