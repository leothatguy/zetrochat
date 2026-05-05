export type UUID = string;

export type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  encryptedKey: string;
  encryptedKeyForSelf: string;
};

export type RegisterRequest = {
  username: string;
  display_name: string;
  password: string;
  public_key: string;
  wrapped_private_key: string;
  pbkdf2_salt: string;
};

export type LoginRequest = {
  username: string;
  password: string;
};

export type RefreshRequest = {
  refresh_token: string;
};

export type UserProfile = {
  id: UUID;
  username: string;
  display_name: string;
  public_key: string;
  wrapped_private_key: string;
  pbkdf2_salt: string;
  created_at: string;
};

export type AuthResponse = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
  user: UserProfile;
};

export type UserPublicInfo = {
  id: UUID;
  username: string;
  display_name: string;
};

export type UserPublicKey = {
  public_key: string;
};

export type ConversationSummary = {
  user_id: UUID;
  username: string;
  display_name: string;
  last_message_at: string | null;
};

export type MessageResponse = {
  id: UUID;
  from_user_id: UUID;
  to_user_id: UUID;
  payload: unknown;
  delivered: boolean;
  created_at: string;
};

export type SendMessageRequest = {
  to: UUID;
  payload: EncryptedPayload;
};

export type StoredKeyEnvelope = {
  userId: UUID;
  wrappedPrivateKey: string;
  pbkdf2Salt: string;
  updatedAt: string;
};

export type DecryptedMessage = {
  id: UUID;
  fromUserId: UUID;
  toUserId: UUID;
  text: string;
  createdAt: string;
  failedToDecrypt: boolean;
};

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<EncryptedPayload>;
  return (
    typeof payload.ciphertext === "string" &&
    typeof payload.iv === "string" &&
    typeof payload.encryptedKey === "string" &&
    typeof payload.encryptedKeyForSelf === "string"
  );
}

