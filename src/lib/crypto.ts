import { arrayBufferToBase64, base64ToArrayBuffer, fromUtf8Bytes, toUtf8Bytes } from "@/lib/encoding";
import type { EncryptedPayload } from "@/lib/types";

const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_SALT_BYTES = 16;
const AES_GCM_IV_BYTES = 12;
const KEY_WRAP_IV_BYTES = 12;

type GeneratedUserKeys = {
  publicKeyBase64: string;
  wrappedPrivateKeyBase64: string;
  pbkdf2SaltBase64: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function joinBuffers(left: ArrayBuffer, right: ArrayBuffer): ArrayBuffer {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  const output = new Uint8Array(leftBytes.byteLength + rightBytes.byteLength);
  output.set(leftBytes, 0);
  output.set(rightBytes, leftBytes.byteLength);
  return output.buffer;
}

function sliceArrayBuffer(buffer: ArrayBuffer, start: number, end?: number): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  return bytes.slice(start, end).buffer;
}

async function deriveWrappingKey(password: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const passwordBytes = toUtf8Bytes(password);
  const passwordMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(passwordBytes),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateAndWrapUserKeys(password: string): Promise<GeneratedUserKeys> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );

  const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const wrappingKey = await deriveWrappingKey(password, toArrayBuffer(pbkdf2Salt));

  const privateKeyPkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const keyWrapIv = crypto.getRandomValues(new Uint8Array(KEY_WRAP_IV_BYTES));
  const encryptedPrivateKey = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: keyWrapIv,
    },
    wrappingKey,
    privateKeyPkcs8,
  );
  const wrappedPrivateKey = joinBuffers(toArrayBuffer(keyWrapIv), encryptedPrivateKey);

  const exportedPublicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey);

  return {
    publicKeyBase64: arrayBufferToBase64(exportedPublicKey),
    wrappedPrivateKeyBase64: arrayBufferToBase64(wrappedPrivateKey),
    pbkdf2SaltBase64: arrayBufferToBase64(toArrayBuffer(pbkdf2Salt)),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

export async function unwrapPrivateKey(
  wrappedPrivateKeyBase64: string,
  pbkdf2SaltBase64: string,
  password: string,
): Promise<CryptoKey> {
  const salt = base64ToArrayBuffer(pbkdf2SaltBase64);
  const wrappedPrivateKey = base64ToArrayBuffer(wrappedPrivateKeyBase64);
  const wrappingKey = await deriveWrappingKey(password, salt);

  if (wrappedPrivateKey.byteLength <= KEY_WRAP_IV_BYTES) {
    throw new Error("Wrapped private key has invalid format.");
  }

  try {
    const iv = sliceArrayBuffer(wrappedPrivateKey, 0, KEY_WRAP_IV_BYTES);
    const ciphertext = sliceArrayBuffer(wrappedPrivateKey, KEY_WRAP_IV_BYTES);
    const privateKeyPkcs8 = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
      },
      wrappingKey,
      ciphertext,
    );

    return crypto.subtle.importKey(
      "pkcs8",
      privateKeyPkcs8,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );
  } catch {
    // Backward compatibility for envelopes created by older AES-KW wrapping.
    return crypto.subtle.unwrapKey(
      "pkcs8",
      wrappedPrivateKey,
      wrappingKey,
      "AES-KW",
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );
  }
}

export async function importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(publicKeyBase64),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt"],
  );
}

export async function encryptPlaintext(
  plaintext: string,
  recipientPublicKey: CryptoKey,
  senderPublicKey: CryptoKey,
): Promise<EncryptedPayload> {
  const aesKey = await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    aesKey,
    toArrayBuffer(toUtf8Bytes(plaintext)),
  );

  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipientPublicKey, rawAesKey);
  const encryptedKeyForSelf = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    senderPublicKey,
    rawAesKey,
  );

  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(toArrayBuffer(iv)),
    encryptedKey: arrayBufferToBase64(encryptedKey),
    encryptedKeyForSelf: arrayBufferToBase64(encryptedKeyForSelf),
  };
}

export async function decryptPayload(
  payload: EncryptedPayload,
  privateKey: CryptoKey,
  useSelfWrappedKey: boolean,
): Promise<string> {
  const wrappedKey = useSelfWrappedKey ? payload.encryptedKeyForSelf : payload.encryptedKey;
  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    base64ToArrayBuffer(wrappedKey),
  );

  const aesKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToArrayBuffer(payload.iv),
    },
    aesKey,
    base64ToArrayBuffer(payload.ciphertext),
  );

  return fromUtf8Bytes(plaintext);
}

