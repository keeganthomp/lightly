/**
 * Sign-In With Solana session store.
 *
 * Flow:
 *   1. client POSTs /auth/nonce { wallet } → server returns { nonce, message }
 *   2. client signs the message with their wallet → POST /auth/verify { wallet, signature }
 *   3. server verifies, mints a sessionId (256-bit random), stores (sessionId → wallet)
 *   4. client opens WS with ?session=<sessionId> — server looks up the wallet;
 *      the URL param is meaningless without knowing the sessionId.
 *
 * The sessionId is the bearer token. It's short-lived (24h) and rotatable.
 * Ship it via httpOnly cookie in production; for the MVP we return it as JSON
 * and let the client put it on the WS URL.
 */
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

const SESSION_TTL_MS = 24 * 60 * 60_000;
const NONCE_TTL_MS = 5 * 60_000;

type NonceEntry = { nonce: string; expiresAt: number };
type SessionEntry = { wallet: string; expiresAt: number };

const nonces = new Map<string, NonceEntry>();
const sessions = new Map<string, SessionEntry>();

export function issueNonce(wallet: string): { nonce: string; message: string } {
  const nonce = crypto.randomUUID();
  nonces.set(wallet, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  return { nonce, message: siwsMessage(wallet, nonce) };
}

export function verifyAndIssueSession(wallet: string, signatureB64: string): string {
  const entry = nonces.get(wallet);
  if (!entry || entry.expiresAt < Date.now()) throw new Error("nonce expired");
  const message = siwsMessage(wallet, entry.nonce);
  const sig = Uint8Array.from(Buffer.from(signatureB64, "base64"));
  const pub = new PublicKey(wallet).toBytes();
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  if (!ok) throw new Error("bad signature");
  nonces.delete(wallet);

  const sessionId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  sessions.set(sessionId, { wallet, expiresAt: Date.now() + SESSION_TTL_MS });
  return sessionId;
}

/** Returns the bound wallet if the session is valid + not expired; null otherwise. */
export function resolveSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return entry.wallet;
}

export function revokeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

function siwsMessage(wallet: string, nonce: string): string {
  return [
    "Sign in to Lightly",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString().slice(0, 19)}Z`,
  ].join("\n");
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}
