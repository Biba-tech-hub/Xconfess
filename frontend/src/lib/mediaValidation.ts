/**
 * Client-side media validation and resilient upload helpers.
 *
 * Scope (issue #33):
 * - Reject unsupported content types and oversized files before any upload begins.
 * - Provide retryable/resumable upload state so progress survives transient failures.
 * - Generate safe previews and release object URLs when no longer needed.
 * - Support upload cancellation with full cleanup of in-flight state and resources.
 */

export const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'application/pdf',
];

export interface MediaValidationOptions {
  allowedMimeTypes?: readonly string[];
  maxFileSizeBytes?: number;
}

export type MediaValidationErrorCode =
  | 'unsupported_type'
  | 'file_too_large'
  | 'empty_file';

export interface MediaValidationError {
  code: MediaValidationErrorCode;
  message: string;
}

export interface MediaValidationResult {
  valid: boolean;
  error?: MediaValidationError;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Validate a file before any upload begins. Returns a structured error so
 * callers can map it to UI copy without throwing.
 */
export function validateMediaFile(
  file: Pick<File, 'type' | 'size' | 'name'>,
  options: MediaValidationOptions = {},
): MediaValidationResult {
  const allowedMimeTypes = options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  if (!file || file.size <= 0) {
    return {
      valid: false,
      error: { code: 'empty_file', message: 'The selected file is empty.' },
    };
  }

  if (file.type && !allowedMimeTypes.includes(file.type)) {
    return {
      valid: false,
      error: {
        code: 'unsupported_type',
        message: `Unsupported file type${file.type ? ` (${file.type})` : ''}. Allowed: ${allowedMimeTypes.join(', ')}.`,
      },
    };
  }

  if (file.size > maxFileSizeBytes) {
    return {
      valid: false,
      error: {
        code: 'file_too_large',
        message: `File is too large (${formatBytes(file.size)}). Maximum allowed is ${formatBytes(maxFileSizeBytes)}.`,
      },
    };
  }

  return { valid: true };
}

/**
 * Create a safe object URL for previewing a file. Callers must release it with
 * `releaseObjectUrl` (or `releaseAllObjectUrls`) when the preview unmounts.
 */
export function createSafeObjectUrl(file: Blob): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

export function releaseObjectUrl(url: string | null | undefined): void {
  if (!url) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Revoking an already-released URL is a no-op; ignore.
  }
}

export function releaseAllObjectUrls(urls: Iterable<string | null | undefined>): void {
  for (const url of urls) {
    releaseObjectUrl(url);
  }
}

export type UploadStatus =
  | 'idle'
  | 'validating'
  | 'uploading'
  | 'retrying'
  | 'canceled'
  | 'failed'
  | 'complete';

export interface UploadState {
  status: UploadStatus;
  /** Bytes successfully transferred so far. */
  uploadedBytes: number;
  totalBytes: number;
  /** 0..1, derived from uploadedBytes/totalBytes. */
  progress: number;
  /** Number of retry attempts already made. */
  attempts: number;
  /** Byte offset to resume from on the next attempt. */
  resumeOffset: number;
  error?: MediaValidationError | { code: string; message: string };
}

export function createUploadState(totalBytes: number): UploadState {
  return {
    status: 'idle',
    uploadedBytes: 0,
    totalBytes: Math.max(0, totalBytes),
    progress: 0,
    attempts: 0,
    resumeOffset: 0,
  };
}

function withProgress(state: UploadState, uploadedBytes: number): UploadState {
  const clamped = Math.max(0, Math.min(uploadedBytes, state.totalBytes));
  return {
    ...state,
    uploadedBytes: clamped,
    resumeOffset: clamped,
    progress: state.totalBytes > 0 ? clamped / state.totalBytes : 0,
  };
}

export function markUploading(state: UploadState): UploadState {
  return { ...state, status: 'uploading', error: undefined };
}

export function recordUploadProgress(state: UploadState, uploadedBytes: number): UploadState {
  return withProgress(state, uploadedBytes);
}

/**
 * Record a transient failure. Progress is preserved so the next attempt can
 * resume from `resumeOffset` instead of restarting from zero.
 */
export function recordUploadFailure(
  state: UploadState,
  error: { code: string; message: string },
  options: { retryable?: boolean } = {},
): UploadState {
  const retryable = options.retryable ?? true;
  return {
    ...state,
    status: retryable ? 'retrying' : 'failed',
    attempts: state.attempts + 1,
    error,
  };
}

/**
 * Prepare the next attempt. Keeps `resumeOffset` so the transport can request
 * only the remaining bytes (resumable upload).
 */
export function prepareRetry(state: UploadState): UploadState {
  return { ...state, status: 'uploading', error: undefined };
}

export function markUploadComplete(state: UploadState): UploadState {
  return { ...state, status: 'complete', uploadedBytes: state.totalBytes, resumeOffset: state.totalBytes, progress: 1 };
}

/**
 * Cancel an in-flight upload and reset transient state. Returns a fresh state
 * so callers can drop references to the previous one.
 */
export function cancelUpload(state: UploadState): UploadState {
  return { ...createUploadState(state.totalBytes), status: 'canceled' };
}

/**
 * Map a server/transport error to a user-facing message. Keeps the original
 * code so callers can branch on it (e.g. retry on 5xx, not on 4xx).
 */
export function mapUploadError(error: unknown): { code: string; message: string; retryable: boolean } {
  const status = extractStatus(error);
  if (status === 413) {
    return { code: 'payload_too_large', message: 'The file is too large for the server.', retryable: false };
  }
  if (status === 415) {
    return { code: 'unsupported_media_type', message: 'The server rejected this file type.', retryable: false };
  }
  if (status === 401 || status === 403) {
    return { code: 'unauthorized', message: 'You are not allowed to upload this file.', retryable: false };
  }
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return { code: 'transient', message: 'Upload failed temporarily. Retrying…', retryable: true };
  }
  if (status !== undefined && status >= 400) {
    return { code: 'request_failed', message: 'Upload failed. Please try again.', retryable: false };
  }
  return { code: 'network_error', message: 'Network error. Retrying…', retryable: true };
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const raw = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof raw === 'number' ? raw : undefined;
}
