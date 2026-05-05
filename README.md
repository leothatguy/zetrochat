# ZetroChat

Secure messaging client for WhisperBox with end-to-end encryption (E2EE).

## Security model

- Message plaintext is encrypted on the client before network transport.
- Server stores only encrypted blobs (`ciphertext`, `iv`, `encryptedKey`, `encryptedKeyForSelf`).
- RSA private key never leaves the client in plaintext.
- Private key is encrypted client-side with AES-GCM from a PBKDF2-derived wrapping key.
- Decryption happens only on recipient (or sender's own) device.

## Implemented features

1. Authentication
   - Register/login/logout/refresh against WhisperBox API.
   - JWT bearer access token usage with refresh retry on 401.
2. Key management
   - Client-side RSA-OAEP key generation on registration.
   - Public key uploaded to backend.
   - Wrapped private key + PBKDF2 salt persisted in IndexedDB envelope.
   - Private key unwrapped only in runtime memory after login.
3. Encrypted messaging
   - AES-GCM per-message content encryption.
   - AES key wrapped with recipient public key and sender public key.
   - WebSocket primary send path (`message.send`) + REST fallback (`POST /messages`).
   - Encrypted history decryption in conversations view.
4. Secure UX
   - Explicit encrypted channel indicator.
   - Graceful decryption failure rendering.
   - Loading and error states for auth, search, conversations, and send.

## API endpoints used

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`
- `GET /users/search?q=...`
- `GET /users/{user_id}/public-key`
- `GET /conversations`
- `GET /conversations/{user_id}/messages`
- `POST /messages`
- WebSocket: `wss://whisperbox.koyeb.app/ws?token=<access_token>`

## Environment

Optional environment variables:

```bash
NEXT_PUBLIC_API_BASE_URL=https://whisperbox.koyeb.app
NEXT_PUBLIC_WS_BASE_URL=wss://whisperbox.koyeb.app/ws
```

## Run locally

```bash
pnpm install
pnpm dev
```

## Notes

- No sensitive data is stored in `localStorage`.
- Deploy behind HTTPS.
- Replay mitigation includes message ID dedupe on inbound processing.
