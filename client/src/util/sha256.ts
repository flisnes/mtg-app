/** Hex SHA-256 of a string or raw bytes (crypto.subtle — main thread or worker). */
export async function sha256Hex(data: string | BufferSource): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
