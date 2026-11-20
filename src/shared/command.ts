export const COMMAND_TEXT_LIMIT = 2_000;
export const VOICE_SECONDS = 30;
export const VOICE_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;
export const VOICE_BYTES_LIMIT =
  WAV_HEADER_BYTES + VOICE_SECONDS * VOICE_SAMPLE_RATE * 2;

export interface CommandCapabilities {
  command: boolean;
  transcription: boolean;
}

export interface CommandChange {
  type: "item" | "project" | "dependency" | "guidance";
  id?: string;
  blockedById?: string;
}

export interface CommandResult {
  summary: string;
  changes: CommandChange[];
  undoId?: string;
}
