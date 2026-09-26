import { useCallback, useEffect, useRef, useState } from 'react';

export interface MediaUploadLimits {
  maxBytes: number;
  allowedTypes: string[];
}

export const DEFAULT_MEDIA_LIMITS: MediaUploadLimits = {
  maxBytes: 25 * 1024 * 1024,
  allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'],
};

export type MediaUploadStatus = 'idle' | 'validating' | 'uploading' | 'retrying' | 'success' | 'error' | 'canceled';

export interface MediaUploadItem {
  id: string;
  file: File;
  previewUrl: string | null;
  status: MediaUploadStatus;
  progress: number;
  attempts: number;
  error: string | null;
}

export interface UseMediaUploadOptions {
  limits?: Partial<MediaUploadLimits>;
  upload: (file: File, signal: AbortSignal, onProgress: (progress: number) => void) => Promise<unknown>;
  maxRetries?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  return true;
}

function mapUploadError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Upload canceled.';
  const status = (error as { status?: number } | null)?.status;
  if (status === 413) return 'File is too large for the server.';
  if (status === 415) return 'Unsupported file type.';
  if (status === 401 || status === 403) return 'You are not allowed to upload this file.';
  if (typeof status === 'number' && status >= 500) return 'Server error while uploading. Please retry.';
  return (error as Error)?.message || 'Upload failed. Please retry.';
}

function validateFile(file: File, limits: MediaUploadLimits): string | null {
  if (file.size > limits.maxBytes) {
    return `File exceeds the ${Math.round(limits.maxBytes / (1024 * 1024))}MB limit.`;
  }
  if (limits.allowedTypes.length > 0 && !limits.allowedTypes.includes(file.type)) {
    return `Unsupported file type: ${file.type || 'unknown'}.`;
  }
  return null;
}

function createPreviewUrl(file: File): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function releasePreviewUrl(url: string | null): void {
  if (!url) return;
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `media-${Date.now()}-${idCounter}`;
}

export function useMediaUpload(options: UseMediaUploadOptions) {
  const limits: MediaUploadLimits = { ...DEFAULT_MEDIA_LIMITS, ...options.limits };
  const maxRetries = options.maxRetries ?? 3;

  const [items, setItems] = useState<MediaUploadItem[]>([]);
  const controllers = useRef<Map<string, AbortController>>(new Map());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      setItems((prev) => {
        prev.forEach((item) => releasePreviewUrl(item.previewUrl));
        return [];
      });
    };
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<MediaUploadItem>) => {
    if (!mounted.current) return;
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const runUpload = useCallback(
    async (item: MediaUploadItem) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);

      let attempt = 0;
      let lastError: unknown = null;

      while (attempt <= maxRetries) {
        attempt += 1;
        patchItem(item.id, {
          status: attempt > 1 ? 'retrying' : 'uploading',
          attempts: attempt,
          error: null,
        });

        try {
          await options.upload(item.file, controller.signal, (progress) => {
            patchItem(item.id, { progress: Math.max(0, Math.min(100, progress)) });
          });
          controllers.current.delete(item.id);
          patchItem(item.id, { status: 'success', progress: 100, error: null });
          return;
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted) {
            controllers.current.delete(item.id);
            patchItem(item.id, { status: 'canceled', error: 'Upload canceled.' });
            return;
          }
          if (attempt > maxRetries || !isRetryableError(error)) break;
          const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          if (controller.signal.aborted) {
            controllers.current.delete(item.id);
            patchItem(item.id, { status: 'canceled', error: 'Upload canceled.' });
            return;
          }
        }
      }

      controllers.current.delete(item.id);
      patchItem(item.id, { status: 'error', error: mapUploadError(lastError) });
    },
    [maxRetries, options, patchItem],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files);
      const accepted: MediaUploadItem[] = [];

      for (const file of incoming) {
        const validationError = validateFile(file, limits);
        if (validationError) {
          accepted.push({
            id: nextId(),
            file,
            previewUrl: null,
            status: 'error',
            progress: 0,
            attempts: 0,
            error: validationError,
          });
          continue;
        }
        accepted.push({
          id: nextId(),
          file,
          previewUrl: createPreviewUrl(file),
          status: 'idle',
          progress: 0,
          attempts: 0,
          error: null,
        });
      }

      setItems((prev) => [...prev, ...accepted]);
      accepted
        .filter((item) => item.status === 'idle')
        .forEach((item) => {
          void runUpload(item);
        });
    },
    [limits, runUpload],
  );

  const retry = useCallback(
    (id: string) => {
      const item = items.find((entry) => entry.id === id);
      if (!item || item.status === 'uploading' || item.status === 'retrying') return;
      void runUpload(item);
    },
    [items, runUpload],
  );

  const cancel = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (controller) {
      controller.abort();
      controllers.current.delete(id);
    }
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, status: 'canceled', error: 'Upload canceled.' } : item,
      ),
    );
  }, []);

  const remove = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (controller) {
      controller.abort();
      controllers.current.delete(id);
    }
    setItems((prev) => {
      const target = prev.find((item) => item.id === id);
      releasePreviewUrl(target?.previewUrl ?? null);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const reset = useCallback(() => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setItems((prev) => {
      prev.forEach((item) => releasePreviewUrl(item.previewUrl));
      return [];
    });
  }, []);

  return { items, addFiles, retry, cancel, remove, reset };
}
