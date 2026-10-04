export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
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
    controller.signal.throwIfAborted();
    const response = await fetch(path, {
      method, credentials: 'same-origin', signal: controller.signal,
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    let data;
    try {
      data = await response.json();
    } catch (error) {
      // Even an empty/non-JSON error response must retain its HTTP status.
      if (response.ok) throw error;
    }
    controller.signal.throwIfAborted();
    if (!response.ok) {
      const message = typeof data?.message === 'string' && data.message.trim()
        ? data.message : 'Request failed. Please retry.';
      const code = typeof data?.error === 'string' ? data.error : undefined;
      throw new ApiError(message, response.status, code);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid server JSON response.');
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ApiError) throw error;
    throw new Error('Cannot reach the NearKey server. Check your connection and retry.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
