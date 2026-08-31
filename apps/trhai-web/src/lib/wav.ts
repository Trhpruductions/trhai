// Turning captured microphone audio into what whisper.cpp actually accepts.
//
// whisper.cpp takes 16 kHz mono 16-bit PCM WAV and nothing else. The browser
// records at whatever the device runs at — usually 44.1 or 48 kHz — and
// MediaRecorder hands back WebM/Opus, which whisper cannot read at all.
//
// The obvious fix is ffmpeg on the server. This does it here instead, which
// removes a second binary from the install: the samples are already in memory
// as floats, resampling them is arithmetic, and a WAV header is 44 bytes.
// Keeping the conversion client-side means the only thing the user has to
// install is whisper itself.

/**
 * What whisper.cpp requires. Mirrors requiredSampleRate in whisperTranscribe.ts.
 *
 * The two are enforced to agree by apps/api/tests/audio-format-agreement.test.ts,
 * which reads this line off disk - trhai-web is not a dependency of that
 * workspace and should not become one for a number. Change this and that test
 * fails, which is the point: if these ever drift, voice input stops working
 * with no error naming the cause. The client sends, the server answers "Audio
 * must be 16 kHz mono", and the microphone simply appears to be broken.
 */
export const targetSampleRate = 16_000;

/**
 * Resample mono float samples to `targetSampleRate` by linear interpolation.
 *
 * Linear rather than a windowed sinc: speech at 16 kHz is dominated by
 * frequencies well under the Nyquist limit, whisper is robust to the small
 * amount of aliasing this leaves, and a proper resampler would be a great deal
 * of code to slightly improve input to a model that will not notice.
 */
export function resampleMono(input: Float32Array, fromRate: number, toRate = targetSampleRate): Float32Array {
  if (fromRate === toRate) return input;
  if (input.length === 0) return input;

  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, input.length - 1);
    const weight = position - lower;
    output[index] = input[lower] * (1 - weight) + input[upper] * weight;
  }

  return output;
}

/**
 * Encode mono float samples as a 16-bit PCM WAV.
 *
 * Floats arrive in -1..1 and are clamped before scaling: a sample past the
 * limit would wrap to the opposite extreme and land in the audio as a click.
 */
export function encodeWav(samples: Float32Array, sampleRate = targetSampleRate): Blob {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  const dataBytes = samples.length * bytesPerSample;

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);              // fmt chunk size
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, 1, true);               // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true);  // block align
  view.setUint16(34, 16, true);              // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    // Asymmetric on purpose: signed 16-bit runs -32768..32767.
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Join the captured chunks into one contiguous buffer. */
export function concatSamples(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
