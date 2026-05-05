const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toUtf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function fromUtf8Bytes(value: ArrayBuffer): string {
  return textDecoder.decode(value);
}

export function arrayBufferToBase64(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(input: string): ArrayBuffer {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

