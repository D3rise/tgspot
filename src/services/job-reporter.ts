export interface SendAudioOptions {
  // Extra text appended to the file's caption in chat. Currently only used
  // by the inline flow to warn about lossless → aac downgrades.
  captionSuffix?: string
}

export interface JobReporter {
  progress(text: string): Promise<void>
  done(text: string): Promise<void>
  cancel(): Promise<void>
  sendAudio(filePath: string, opts?: SendAudioOptions): Promise<void>
  workingIndication(): void
  stopWorkingIndication(): void
}
