import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key() {
  const k = Buffer.from(process.env.TOKEN_ENC_KEY ?? "", "base64");
  if (k.length !== 32) {
    throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  }
  return k;
}

export function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt(encoded) {
  const buf = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
