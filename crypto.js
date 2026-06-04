const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function hashPin(pin, saltBase64) {
  const salt =
    saltBase64 != null
      ? base64ToBuffer(saltBase64)
      : crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBase64 != null ? new Uint8Array(salt) : salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  return {
    hash: bufferToBase64(hashBuffer),
    salt: bufferToBase64(salt),
  };
}

async function verifyPin(pin, storedHash, storedSalt) {
  const { hash } = await hashPin(pin, storedSalt);
  return hash === storedHash;
}
