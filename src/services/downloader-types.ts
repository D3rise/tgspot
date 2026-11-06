export class DownloadAuthError extends Error {}
export class DownloadError extends Error {}

export interface DownloadResult {
  workDir: string
  files: string[]
}

export type DownloadPhase = 'download' | 'transcode'

export interface DownloadProgress {
  percent: number | null
  phase: DownloadPhase
  label?: string
}

export type ProgressListener = (progress: DownloadProgress) => void

export type YandexQuality = 'high' | 'lossless'

export interface DownloadOptions {
  attempts?: number
  onProgress?: ProgressListener
  // yandex-only: 'high' = AAC 192 (.m4a), 'lossless' = FLAC (.flac). Ignored for Spotify.
  quality?: YandexQuality
}

export interface TrackDownloader {
  downloadWithRetry(url: string, opts?: DownloadOptions): Promise<DownloadResult>
  cleanup(workDir: string): Promise<void>
}
