import {
  VOICE_SAMPLE_RATE,
  VOICE_SECONDS,
  WAV_HEADER_BYTES,
} from "@heedwork/core";

interface SpeechRecognition extends EventTarget {
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionConstructor() {
  const browser = window as Window & {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

function canRecord() {
  return Boolean(
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder === "function" &&
    typeof window.OfflineAudioContext === "function",
  );
}

export function voiceAvailable(fallback: boolean) {
  return Boolean(recognitionConstructor() || (fallback && canRecord()));
}

function aborted(signal: AbortSignal) {
  if (signal.aborted)
    throw new DOMException("Recording cancelled", "AbortError");
}

async function recognize(stopped: AbortSignal, cancelled: AbortSignal) {
  const Recognition = recognitionConstructor();
  if (!Recognition) throw new Error("Speech recognition is unavailable.");
  const speech = new Recognition();
  speech.lang = navigator.language;
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let error: Error | undefined;
    const stop = () => speech.stop();
    const cancel = () => speech.abort();
    speech.addEventListener("result", (event) => {
      const { results } = event as Event & {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      };
      text = Array.from(results, (result) => result[0].transcript).join(" ");
    });
    speech.addEventListener("error", () => {
      error = new Error("Speech recognition failed.");
    });
    speech.addEventListener(
      "end",
      () => {
        stopped.removeEventListener("abort", stop);
        cancelled.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(text);
      },
      { once: true },
    );
    speech.start();
    stopped.addEventListener("abort", stop, { once: true });
    cancelled.addEventListener("abort", cancel, { once: true });
  });
}

function encodeWave(audio: AudioBuffer) {
  const frames = Math.min(audio.length, VOICE_SECONDS * VOICE_SAMPLE_RATE);
  const bytes = frames * 2;
  const output = new ArrayBuffer(WAV_HEADER_BYTES + bytes);
  const header = new DataView(output);
  header.setUint32(0, 0x52494646); // RIFF
  header.setUint32(4, bytes + WAV_HEADER_BYTES - 8, true);
  header.setUint32(8, 0x57415645); // WAVE
  header.setUint32(12, 0x666d7420); // fmt
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // Mono
  header.setUint32(24, VOICE_SAMPLE_RATE, true);
  header.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(36, 0x64617461); // data
  header.setUint32(40, bytes, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  for (let index = 0; index < frames; index++) {
    let sum = 0;
    for (const channel of channels) sum += channel[index];
    const sample = Math.max(-1, Math.min(1, sum / channels.length));
    header.setInt16(
      WAV_HEADER_BYTES + index * 2,
      sample * (sample < 0 ? 32768 : 32767),
      true,
    );
  }
  return output;
}

async function record(stopped: AbortSignal, cancelled: AbortSignal) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    aborted(cancelled);
    if (stopped.aborted) throw new Error("Hold the microphone while speaking.");
    const recorder = new MediaRecorder(stream);
    return await new Promise<Blob>((resolve, reject) => {
      const stop = () => {
        if (recorder.state !== "inactive") recorder.stop();
      };
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", ({ data }) =>
        chunks.push(data),
      );
      recorder.addEventListener(
        "error",
        () => reject(new Error("Could not record audio.")),
        { once: true },
      );
      recorder.addEventListener(
        "stop",
        () => {
          stopped.removeEventListener("abort", stop);
          cancelled.removeEventListener("abort", stop);
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        },
        { once: true },
      );
      recorder.start();
      stopped.addEventListener("abort", stop, { once: true });
      cancelled.addEventListener("abort", stop, { once: true });
    });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

export async function postCommandApi<T>(
  path: string,
  body: BodyInit,
  type: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": type },
    body,
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? "The request failed. Try again.");
  }
  return response.json();
}

export async function voiceTranscript({
  fallback,
  preferRecording,
  stopped,
  cancelled,
  onTranscribing,
  onFallback,
}: {
  fallback: boolean;
  preferRecording: boolean;
  stopped: AbortSignal;
  cancelled: AbortSignal;
  onTranscribing: () => void;
  onFallback: () => void;
}) {
  if (!preferRecording && recognitionConstructor()) {
    try {
      return await recognize(stopped, cancelled);
    } catch {
      aborted(cancelled);
      if (!fallback || !canRecord()) {
        throw new Error(
          "Speech recognition is unavailable. Type your command instead.",
        );
      }
      onFallback();
      if (stopped.aborted)
        throw new Error(
          "Speech recognition failed. Hold the microphone again to record.",
        );
    }
  }
  const recording = await record(stopped, cancelled);
  aborted(cancelled);
  if (!recording.size) return "";
  onTranscribing();
  const context = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE);
  const audio = await context.decodeAudioData(await recording.arrayBuffer());
  aborted(cancelled);
  const result = await postCommandApi<{ text: string }>(
    "/api/transcribe",
    encodeWave(audio),
    "audio/wav",
    cancelled,
  );
  return result.text;
}
