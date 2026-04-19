/**
 * Sign-In With Solana — client side.
 *
 * 1. GET /auth/nonce { wallet } → { message }
 * 2. signMessage(message) via wallet-adapter
 * 3. POST /auth/verify { wallet, signature } → { sessionId }
 * 4. Store sessionId in sessionStorage; pass on WS URL.
 *
 * Session auto-cleared on wallet disconnect.
 */
const API = import.meta.env.VITE_API_URL ?? "/api";
const SESSION_KEY = "lightly.session";
const WALLET_KEY = "lightly.wallet";

export function getSession(wallet: string): string | null {
  const stored = sessionStorage.getItem(SESSION_KEY);
  const storedWallet = sessionStorage.getItem(WALLET_KEY);
  if (!stored || storedWallet !== wallet) return null;
  return stored;
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(WALLET_KEY);
}

export async function signIn(
  wallet: string,
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  const nonceRes = await fetch(`${API}/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  if (!nonceRes.ok) throw new Error(`nonce failed: ${await nonceRes.text()}`);
  const { message } = (await nonceRes.json()) as { message: string };

  const signature = await signMessage(new TextEncoder().encode(message));
  const sigB64 = bytesToBase64(signature);

  const verifyRes = await fetch(`${API}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, signature: sigB64 }),
  });
  if (!verifyRes.ok) throw new Error(`verify failed: ${await verifyRes.text()}`);
  const { sessionId } = (await verifyRes.json()) as { sessionId: string };

  sessionStorage.setItem(SESSION_KEY, sessionId);
  sessionStorage.setItem(WALLET_KEY, wallet);
  return sessionId;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const n of b) s += String.fromCharCode(n);
  return btoa(s);
}
