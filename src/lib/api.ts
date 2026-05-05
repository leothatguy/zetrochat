import { appConfig } from "@/lib/config";
import type {
  AuthResponse,
  ConversationSummary,
  LoginRequest,
  MessageResponse,
  RefreshRequest,
  RegisterRequest,
  SendMessageRequest,
  UserProfile,
  UserPublicInfo,
  UserPublicKey,
  UUID,
} from "@/lib/types";

type RequestOptions = {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
};

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    let detail = `Request failed with status ${response.status}`;
    try {
      const errorBody = (await response.json()) as { detail?: string };
      if (typeof errorBody.detail === "string") {
        detail = errorBody.detail;
      }
    } catch {
      // Use default detail when response body is not JSON.
    }
    throw new ApiError(detail, response.status);
  }

  return (await response.json()) as T;
}

export const whisperboxClient = {
  register(payload: RegisterRequest): Promise<AuthResponse> {
    return requestJson<AuthResponse>("/auth/register", { method: "POST", body: payload });
  },

  login(payload: LoginRequest): Promise<AuthResponse> {
    return requestJson<AuthResponse>("/auth/login", { method: "POST", body: payload });
  },

  refresh(payload: RefreshRequest): Promise<{ access_token: string; token_type?: string; expires_in: number }> {
    return requestJson("/auth/refresh", { method: "POST", body: payload });
  },

  logout(payload: RefreshRequest, accessToken: string): Promise<Record<string, unknown>> {
    return requestJson("/auth/logout", { method: "POST", token: accessToken, body: payload });
  },

  me(accessToken: string): Promise<UserProfile> {
    return requestJson("/auth/me", { token: accessToken });
  },

  searchUsers(query: string, accessToken: string): Promise<UserPublicInfo[]> {
    return requestJson(`/users/search?q=${encodeURIComponent(query)}`, { token: accessToken });
  },

  getUserPublicKey(userId: UUID, accessToken: string): Promise<UserPublicKey> {
    return requestJson(`/users/${userId}/public-key`, { token: accessToken });
  },

  getConversations(accessToken: string): Promise<ConversationSummary[]> {
    return requestJson("/conversations", { token: accessToken });
  },

  getConversationMessages(
    userId: UUID,
    accessToken: string,
    options?: { before?: string; limit?: number },
  ): Promise<MessageResponse[]> {
    const params = new URLSearchParams();
    if (options?.before) {
      params.set("before", options.before);
    }
    if (options?.limit) {
      params.set("limit", `${options.limit}`);
    }

    const query = params.toString();
    return requestJson(`/conversations/${userId}/messages${query ? `?${query}` : ""}`, { token: accessToken });
  },

  sendMessage(payload: SendMessageRequest, accessToken: string): Promise<MessageResponse> {
    return requestJson("/messages", { method: "POST", token: accessToken, body: payload });
  },
};

