export interface JobReporter {
  progress(text: string): Promise<void>
  done(text: string): Promise<void>
  cancel(): Promise<void>
  sendAudio(filePath: string): Promise<void>
  workingIndication(): void
  stopWorkingIndication(): void
}
