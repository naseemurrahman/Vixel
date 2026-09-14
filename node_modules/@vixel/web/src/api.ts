let token: string | null = localStorage.getItem("vixel_token");

export function setToken(t: string | null) {
  token = t;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  auth = true
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (auth && token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || res.statusText);
  }
  return data as T;
}
