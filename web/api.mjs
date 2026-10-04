export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, {method = 'GET', body, signal, timeoutMs = 8_000} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('Network request timed out. Check your connection and retry.')), timeoutMs);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', signal: controller.signal,
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.message || 'Request failed. Please retry.', response.status, data.error);
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ApiError) throw error;
    throw new Error('Cannot reach the bank server. Check your connection and retry.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
