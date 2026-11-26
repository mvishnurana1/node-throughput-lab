import crypto from "crypto";

// Kept free of database imports so scripts like seed.js can use it without
// opening a Redis connection (which used to stop them from ever exiting).

const generateCode = () => {
  // 375 random bytes becomes 500 Base64 characters
  return crypto.randomBytes(375).toString("base64").substring(0, 500);
};

/**
 * A 44-character SHA-256 fingerprint of a code. The Redis uniqueness set stores
 * this instead of the full 500-character code. Measured on Redis 7: 560 bytes
 * per entry down to 96 (about 11.2 GB -> 1.9 GB at 20 million codes), while
 * collisions stay practically impossible.
 */
const codeFingerprint = (code) =>
  crypto.createHash("sha256").update(code).digest("base64");

export { generateCode, codeFingerprint };
