"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Override browser autofill styling
const autofillStyles = `
  input:-webkit-autofill,
  input:-webkit-autofill:hover,
  input:-webkit-autofill:focus,
  input:-webkit-autofill:active {
    -webkit-box-shadow: 0 0 0 1000px rgba(0, 0, 0, 0.6) inset !important;
    -webkit-text-fill-color: #ffffff !important;
    caret-color: #ffffff !important;
    transition: background-color 5000s ease-in-out 0s;
  }
`;
import { ApiError, whisperboxClient } from "@/lib/api";
import { appConfig } from "@/lib/config";
import {
  decryptPayload,
  encryptPlaintext,
  generateAndWrapUserKeys,
  importPublicKey,
  unwrapPrivateKey,
} from "@/lib/crypto";
import {
  getKeyEnvelope,
  getThreadReadMap,
  removeKeyEnvelope,
  saveKeyEnvelope,
  setThreadReadAt,
} from "@/lib/storage";
import type {
  ConversationSummary,
  DecryptedMessage,
  MessageResponse,
  UserProfile,
  UserPublicInfo,
  UUID,
} from "@/lib/types";
import { isEncryptedPayload } from "@/lib/types";
import {
  validateDisplayName,
  validateMessageText,
  validatePassword,
  validateSearchQuery,
  validateUsername,
} from "@/lib/validation";

type AuthMode = "login" | "register";

type Session = {
  user: UserProfile;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toMs(timestamp: string | null | undefined): number {
  if (!timestamp) {
    return 0;
  }
  return new Date(timestamp).getTime();
}

export function SecureChatApp() {
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [selfPublicKey, setSelfPublicKey] = useState<CryptoKey | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<UserPublicInfo[]>([]);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<UUID | null>(null);
  const [mobileActivePane, setMobileActivePane] = useState<"list" | "chat">("list");
  const [unreadByUser, setUnreadByUser] = useState<Record<string, number>>({});
  const [messagesByUser, setMessagesByUser] = useState<Record<string, DecryptedMessage[]>>({});
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composeMessageByUser, setComposeMessageByUser] = useState<Record<string, string>>({});
  const [sendLoading, setSendLoading] = useState(false);
  const [wsStatus, setWsStatus] = useState<"online" | "offline">("offline");

  const wsRef = useRef<WebSocket | null>(null);
  const messagesViewportRef = useRef<HTMLElement | null>(null);
  const refreshInFlightRef = useRef<Promise<string> | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const offlineIndicatorTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const manualSocketCloseRef = useRef(false);
  const loadedThreadIdsRef = useRef<Set<string>>(new Set());
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const publicKeyCacheRef = useRef<Map<UUID, CryptoKey>>(new Map());

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.user_id === selectedUserId) ?? null,
    [conversations, selectedUserId],
  );
  const selectedMessages = selectedUserId ? (messagesByUser[selectedUserId] ?? []) : [];
  const composeMessage = selectedUserId ? (composeMessageByUser[selectedUserId] ?? "") : "";
  const newestMessageId = selectedMessages[selectedMessages.length - 1]?.id ?? null;
  const hasUnreadOutsideSelectedConversation = useMemo(
    () =>
      Object.entries(unreadByUser).some(
        ([userId, count]) => count > 0 && userId !== (selectedUserId ?? ""),
      ),
    [selectedUserId, unreadByUser],
  );

  const closeSocket = useCallback(() => {
    manualSocketCloseRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const clearSessionState = useCallback(() => {
    closeSocket();
    setSession(null);
    setPrivateKey(null);
    setSelfPublicKey(null);
    setConversations([]);
    setSelectedUserId(null);
    setMobileActivePane("list");
    setUnreadByUser({});
    setMessagesByUser({});
    setSearchResults([]);
    setSearchQuery("");
    setComposeMessageByUser({});
    setWsStatus("offline");
    if (offlineIndicatorTimerRef.current !== null) {
      window.clearTimeout(offlineIndicatorTimerRef.current);
      offlineIndicatorTimerRef.current = null;
    }
    loadedThreadIdsRef.current.clear();
    seenMessageIdsRef.current.clear();
    publicKeyCacheRef.current.clear();
  }, [closeSocket]);

  const markSocketOnline = useCallback(() => {
    if (offlineIndicatorTimerRef.current !== null) {
      window.clearTimeout(offlineIndicatorTimerRef.current);
      offlineIndicatorTimerRef.current = null;
    }
    setWsStatus("online");
  }, []);

  const markSocketOfflineDebounced = useCallback(() => {
    if (offlineIndicatorTimerRef.current !== null) {
      return;
    }
    offlineIndicatorTimerRef.current = window.setTimeout(() => {
      offlineIndicatorTimerRef.current = null;
      setWsStatus("offline");
    }, 2500);
  }, []);

  const refreshAccessToken = useCallback(async (): Promise<string> => {
    if (!session) {
      throw new Error("No active session.");
    }
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }

    const promise = whisperboxClient
      .refresh({ refresh_token: session.refreshToken })
      .then((result) => {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                accessToken: result.access_token,
                accessTokenExpiresAt: Date.now() + result.expires_in * 1000,
              }
            : prev,
        );
        return result.access_token;
      })
      .finally(() => {
        refreshInFlightRef.current = null;
      });

    refreshInFlightRef.current = promise;
    return promise;
  }, [session]);

  const withAuth = useCallback(
    async <T,>(action: (accessToken: string) => Promise<T>): Promise<T> => {
      if (!session) {
        throw new Error("Not authenticated.");
      }
      try {
        return await action(session.accessToken);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const refreshedToken = await refreshAccessToken();
          return action(refreshedToken);
        }
        throw error;
      }
    },
    [refreshAccessToken, session],
  );

  const decryptMessageWithKey = useCallback(
    async (
      message: MessageResponse,
      activePrivateKey: CryptoKey,
      currentUserId: UUID,
    ): Promise<DecryptedMessage> => {
      if (!isEncryptedPayload(message.payload)) {
        return {
          id: message.id,
          fromUserId: message.from_user_id,
          toUserId: message.to_user_id,
          text: "[Encrypted message unavailable]",
          createdAt: message.created_at,
          failedToDecrypt: true,
        };
      }

      const useSelfWrappedKey = message.from_user_id === currentUserId;
      try {
        const plaintext = await decryptPayload(message.payload, activePrivateKey, useSelfWrappedKey);
        return {
          id: message.id,
          fromUserId: message.from_user_id,
          toUserId: message.to_user_id,
          text: plaintext,
          createdAt: message.created_at,
          failedToDecrypt: false,
        };
      } catch {
        return {
          id: message.id,
          fromUserId: message.from_user_id,
          toUserId: message.to_user_id,
          text: "[Unable to decrypt this message]",
          createdAt: message.created_at,
          failedToDecrypt: true,
        };
      }
    },
    [],
  );

  const decryptMessage = useCallback(
    async (message: MessageResponse): Promise<DecryptedMessage> => {
      if (!session || !privateKey) {
        return {
          id: message.id,
          fromUserId: message.from_user_id,
          toUserId: message.to_user_id,
          text: "[Encrypted message unavailable]",
          createdAt: message.created_at,
          failedToDecrypt: true,
        };
      }
      return decryptMessageWithKey(message, privateKey, session.user.id);
    },
    [decryptMessageWithKey, privateKey, session],
  );

  const applyServerConversations = useCallback((entries: ConversationSummary[]) => {
    const sorted = [...entries].sort((left, right) => {
      const leftTime = left.last_message_at ? new Date(left.last_message_at).getTime() : 0;
      const rightTime = right.last_message_at ? new Date(right.last_message_at).getTime() : 0;
      return rightTime - leftTime;
    });
    setConversations(sorted);
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!session) {
      return;
    }
    const entries = await withAuth((token) => whisperboxClient.getConversations(token));
    applyServerConversations(entries);
  }, [applyServerConversations, session, withAuth]);

  const hydrateUnreadCounts = useCallback(
    async (entries: ConversationSummary[], accessToken: string, currentUserId: UUID) => {
      const threadReadMap = await getThreadReadMap(currentUserId);
      const unreadCounts: Record<string, number> = {};

      await Promise.all(
        entries.map(async (entry) => {
          const lastReadAt = threadReadMap[entry.user_id];
          if (entry.last_message_at && toMs(lastReadAt) >= toMs(entry.last_message_at)) {
            return;
          }

          const messages = await whisperboxClient.getConversationMessages(entry.user_id, accessToken, {
            limit: 50,
          });
          const unread = messages.filter(
            (message) =>
              message.from_user_id !== currentUserId &&
              (!lastReadAt || toMs(message.created_at) > toMs(lastReadAt)),
          ).length;
          if (unread > 0) {
            unreadCounts[entry.user_id] = unread;
          }
        }),
      );

      setUnreadByUser(unreadCounts);
    },
    [],
  );

  const mergeMessages = useCallback((threadUserId: UUID, items: DecryptedMessage[]) => {
    setMessagesByUser((prev) => {
      const existing = prev[threadUserId] ?? [];
      const merged = [...existing];
      for (const item of items) {
        if (!merged.some((message) => message.id === item.id)) {
          merged.push(item);
        }
      }
      merged.sort(
        (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
      );
      return {
        ...prev,
        [threadUserId]: merged,
      };
    });
  }, []);

  const loadConversationMessages = useCallback(
    async (
      userId: UUID,
      context?: { accessToken: string; privateKey: CryptoKey; currentUserId: UUID },
      options?: { silent?: boolean },
    ) => {
      const activePrivateKey = context?.privateKey ?? privateKey;
      const currentUserId = context?.currentUserId ?? session?.user.id;
      if (!activePrivateKey || !currentUserId) {
        return;
      }

      if (!options?.silent) {
        setMessagesLoading(true);
      }
      try {
        const messages = context
          ? await whisperboxClient.getConversationMessages(userId, context.accessToken, { limit: 50 })
          : await withAuth((token) => whisperboxClient.getConversationMessages(userId, token, { limit: 50 }));

        const decrypted = await Promise.all(
          messages.map((message) => decryptMessageWithKey(message, activePrivateKey, currentUserId)),
        );
        for (const message of decrypted) {
          seenMessageIdsRef.current.add(message.id);
        }
        mergeMessages(userId, decrypted);
        loadedThreadIdsRef.current.add(userId);
      } finally {
        if (!options?.silent) {
          setMessagesLoading(false);
        }
      }
    },
    [decryptMessageWithKey, mergeMessages, privateKey, session, withAuth],
  );

  useEffect(() => {
    if (!selectedUserId || !session || !privateKey) {
      return;
    }
    const id = selectedUserId;
    if (loadedThreadIdsRef.current.has(id)) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void loadConversationMessages(id);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadConversationMessages, privateKey, selectedUserId, session]);

  const selectConversation = useCallback(
    (userId: UUID, options?: { openChatOnMobile?: boolean }) => {
      const shouldOpenChatOnMobile = options?.openChatOnMobile ?? true;
      if (shouldOpenChatOnMobile) {
        setMobileActivePane("chat");
      }
    setErrorText(null);
    setStatusText(null);
    setSelectedUserId(userId);
    setUnreadByUser((prev) => {
      if (!prev[userId]) {
        return prev;
      }
      return {
        ...prev,
        [userId]: 0,
      };
    });
      if (session) {
        const latestKnownMessageTime =
          messagesByUser[userId]?.[messagesByUser[userId].length - 1]?.createdAt ??
          conversations.find((conversation) => conversation.user_id === userId)?.last_message_at ??
          new Date().toISOString();
        void setThreadReadAt(session.user.id, userId, latestKnownMessageTime);
      }
    },
    [conversations, messagesByUser, session],
  );

  const getRecipientPublicKey = useCallback(
    async (userId: UUID): Promise<CryptoKey> => {
      const existing = publicKeyCacheRef.current.get(userId);
      if (existing) {
        return existing;
      }
      const result = await withAuth((token) => whisperboxClient.getUserPublicKey(userId, token));
      const imported = await importPublicKey(result.public_key);
      publicKeyCacheRef.current.set(userId, imported);
      return imported;
    },
    [withAuth],
  );

  const appendIncomingMessage = useCallback(
    async (message: MessageResponse) => {
      if (!session) {
        return;
      }
      if (seenMessageIdsRef.current.has(message.id)) {
        return;
      }
      seenMessageIdsRef.current.add(message.id);
      const decrypted = await decryptMessage(message);
      const threadUserId =
        message.from_user_id === session.user.id ? message.to_user_id : message.from_user_id;
      mergeMessages(threadUserId, [decrypted]);
      if (message.from_user_id !== session.user.id && threadUserId !== selectedUserId) {
        setUnreadByUser((prev) => ({
          ...prev,
          [threadUserId]: (prev[threadUserId] ?? 0) + 1,
        }));
      } else if (message.from_user_id !== session.user.id && threadUserId === selectedUserId) {
        void setThreadReadAt(session.user.id, threadUserId, message.created_at);
      }
      setConversations((prev) => {
        const existing = prev.find((conversation) => conversation.user_id === threadUserId);
        if (existing) {
          return prev.map((conversation) =>
            conversation.user_id === threadUserId
              ? { ...conversation, last_message_at: message.created_at }
              : conversation,
          );
        }
        return [
          {
            user_id: threadUserId,
            username: `user-${threadUserId.slice(0, 8)}`,
            display_name: "New contact",
            last_message_at: message.created_at,
          },
          ...prev,
        ];
      });
      void refreshConversations();
    },
    [decryptMessage, mergeMessages, refreshConversations, selectedUserId, session],
  );

  const connectSocket = useCallback(() => {
    if (!session || !privateKey) {
      return;
    }
    closeSocket();
    manualSocketCloseRef.current = false;

    const openSocket = (token: string) => {
      const socket = new WebSocket(`${appConfig.wsBaseUrl}?token=${encodeURIComponent(token)}`);
      wsRef.current = socket;

      socket.onopen = () => {
        markSocketOnline();
        reconnectAttemptRef.current = 0;
      };

      socket.onclose = () => {
        markSocketOfflineDebounced();
        if (manualSocketCloseRef.current || !session || !privateKey) {
          return;
        }
        if (reconnectTimerRef.current !== null) {
          return;
        }
        const delayMs = Math.min(1000 * 2 ** reconnectAttemptRef.current, 10_000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(async () => {
          reconnectTimerRef.current = null;
          if (!session || !privateKey) {
            return;
          }
          let nextToken = session.accessToken;
          try {
            nextToken = await refreshAccessToken();
          } catch {
            // Keep retrying reconnect even if refresh fails transiently.
          }
          openSocket(nextToken);
        }, delayMs);
      };

      socket.onerror = () => {
        markSocketOfflineDebounced();
      };

      socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const frame = parsed as {
        type?: string;
        data?: unknown;
        from_user_id?: string;
        to_user_id?: string;
      };

      if (
        frame.type === "message.receive" &&
        frame.data &&
        typeof frame.data === "object" &&
        "id" in frame.data
      ) {
        void appendIncomingMessage(frame.data as MessageResponse);
        return;
      }
      if ("id" in frame && "from_user_id" in frame && "to_user_id" in frame) {
        void appendIncomingMessage(frame as unknown as MessageResponse);
      }
    };
    };

    openSocket(session.accessToken);
  }, [
    appendIncomingMessage,
    closeSocket,
    markSocketOfflineDebounced,
    markSocketOnline,
    privateKey,
    refreshAccessToken,
    session,
  ]);

  useEffect(() => {
    if (!session || !privateKey) {
      closeSocket();
      return;
    }
    connectSocket();
    return () => closeSocket();
  }, [closeSocket, connectSocket, privateKey, session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const refreshAt = Math.max(session.accessTokenExpiresAt - Date.now() - 60_000, 5_000);
    const timeoutId = window.setTimeout(() => {
      void refreshAccessToken();
    }, refreshAt);
    return () => window.clearTimeout(timeoutId);
  }, [refreshAccessToken, session]);

  useEffect(() => {
    if (!selectedUserId) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [newestMessageId, selectedUserId]);

  useEffect(() => {
    if (!statusText) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setStatusText((current) => (current === statusText ? null : current));
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [statusText]);

  useEffect(() => {
    if (!errorText) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setErrorText((current) => (current === errorText ? null : current));
    }, 4500);
    return () => window.clearTimeout(timeoutId);
  }, [errorText]);

  const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorText(null);
    setStatusText(null);

    const usernameError = validateUsername(username);
    const displayNameError = validateDisplayName(displayName);
    const passwordError = validatePassword(password);
    if (usernameError || displayNameError || passwordError) {
      setErrorText(usernameError ?? displayNameError ?? passwordError);
      return;
    }

    setAuthLoading(true);
    try {
      const keyMaterial = await generateAndWrapUserKeys(password);
      const response = await whisperboxClient.register({
        username: username.trim(),
        display_name: displayName.trim(),
        password,
        public_key: keyMaterial.publicKeyBase64,
        wrapped_private_key: keyMaterial.wrappedPrivateKeyBase64,
        pbkdf2_salt: keyMaterial.pbkdf2SaltBase64,
      });

      await saveKeyEnvelope({
        userId: response.user.id,
        wrappedPrivateKey: response.user.wrapped_private_key,
        pbkdf2Salt: response.user.pbkdf2_salt,
        updatedAt: new Date().toISOString(),
      });

      setSession({
        user: response.user,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
      });
      setPrivateKey(keyMaterial.privateKey);
      setSelfPublicKey(keyMaterial.publicKey);
      setConversationsLoading(true);
      const entries = await whisperboxClient.getConversations(response.access_token);
      applyServerConversations(entries);
      setUnreadByUser({});
      if (entries.length > 0) {
        selectConversation(entries[0].user_id, { openChatOnMobile: false });
        void loadConversationMessages(entries[0].user_id, {
          accessToken: response.access_token,
          privateKey: keyMaterial.privateKey,
          currentUserId: response.user.id,
        });
      }
      setConversationsLoading(false);
      setPassword("");
      setStatusText("Account created with client-side key generation.");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to register.");
    } finally {
      setConversationsLoading(false);
      setAuthLoading(false);
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorText(null);
    setStatusText(null);

    const usernameError = validateUsername(username);
    const passwordError = validatePassword(password);
    if (usernameError || passwordError) {
      setErrorText(usernameError ?? passwordError);
      return;
    }

    setAuthLoading(true);
    try {
      const response = await whisperboxClient.login({ username: username.trim(), password });

      const localEnvelope = await getKeyEnvelope(response.user.id);
      const wrappedPrivateKey =
        localEnvelope?.wrappedPrivateKey ?? response.user.wrapped_private_key;
      const pbkdf2Salt = localEnvelope?.pbkdf2Salt ?? response.user.pbkdf2_salt;
      const unwrappedPrivateKey = await unwrapPrivateKey(wrappedPrivateKey, pbkdf2Salt, password);
      const importedPublicKey = await importPublicKey(response.user.public_key);

      await saveKeyEnvelope({
        userId: response.user.id,
        wrappedPrivateKey: response.user.wrapped_private_key,
        pbkdf2Salt: response.user.pbkdf2_salt,
        updatedAt: new Date().toISOString(),
      });

      setSession({
        user: response.user,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
      });
      setPrivateKey(unwrappedPrivateKey);
      setSelfPublicKey(importedPublicKey);
      setConversationsLoading(true);
      const entries = await whisperboxClient.getConversations(response.access_token);
      applyServerConversations(entries);
      await hydrateUnreadCounts(entries, response.access_token, response.user.id);
      if (entries.length > 0) {
        selectConversation(entries[0].user_id, { openChatOnMobile: false });
        void loadConversationMessages(entries[0].user_id, {
          accessToken: response.access_token,
          privateKey: unwrappedPrivateKey,
          currentUserId: response.user.id,
        });
      }
      setConversationsLoading(false);
      setPassword("");
      setStatusText("Logged in. Private key decrypted locally.");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to login.");
    } finally {
      setConversationsLoading(false);
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (!session) {
      return;
    }
    setErrorText(null);
    setStatusText(null);
    try {
      await whisperboxClient.logout({ refresh_token: session.refreshToken }, session.accessToken);
      setStatusText("Session closed.");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to revoke remote session.");
    } finally {
      await removeKeyEnvelope(session.user.id);
      clearSessionState();
    }
  };

  const handleSearchUsers = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorText(null);

    if (!session) {
      setErrorText("Please login first.");
      return;
    }

    const validationError = validateSearchQuery(searchQuery);
    if (validationError) {
      setErrorText(validationError);
      return;
    }

    setSearchLoading(true);
    try {
      const results = await withAuth((token) => whisperboxClient.searchUsers(searchQuery.trim(), token));
      setSearchResults(results.filter((entry) => entry.id !== session.user.id));
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Search failed.");
    } finally {
      setSearchLoading(false);
    }
  };

  const handlePickConversation = (user: UserPublicInfo | ConversationSummary) => {
    const conversationEntry: ConversationSummary = {
      user_id: "user_id" in user ? user.user_id : user.id,
      username: user.username,
      display_name: user.display_name,
      last_message_at: "last_message_at" in user ? user.last_message_at : null,
    };

    setConversations((prev) => {
      if (prev.some((entry) => entry.user_id === conversationEntry.user_id)) {
        return prev;
      }
      return [conversationEntry, ...prev];
    });
    selectConversation(conversationEntry.user_id);
  };

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorText(null);
    setStatusText(null);

    if (!session || !privateKey || !selfPublicKey || !selectedUserId) {
      setErrorText("Missing secure session or active conversation.");
      return;
    }
    const validationError = validateMessageText(composeMessage);
    if (validationError) {
      setErrorText(validationError);
      return;
    }

    setSendLoading(true);
    try {
      const recipientPublicKey = await getRecipientPublicKey(selectedUserId);
      const payload = await encryptPlaintext(composeMessage.trim(), recipientPublicKey, selfPublicKey);
      const threadUserId = selectedUserId;
      const message = await withAuth((token) =>
        whisperboxClient.sendMessage({ to: threadUserId, payload }, token),
      );
      await appendIncomingMessage(message);
      setStatusText("Encrypted message sent.");
      setComposeMessageByUser((prev) => ({ ...prev, [threadUserId]: "" }));
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to send encrypted message.");
    } finally {
      setSendLoading(false);
    }
  };

  if (!session || !privateKey || !selfPublicKey) {
    return (
      <div className="min-h-full bg-black text-white flex items-center justify-center p-6 relative overflow-hidden">
          <style>{autofillStyles}</style>  
        <section className="relative w-full max-w-md border border-[#00f3ff]/30 bg-black/40 backdrop-blur-2xl p-8 z-10 transition-all duration-300">
          <div className="mb-8 text-center">
            <h1 className="text-4xl font-bold tracking-wider text-[#00f3ff] uppercase font-mono">ZetroChat</h1>
            <p className="text-sm text-white/50 mt-3 font-light tracking-wide">
              End-to-end encrypted messaging.
            </p>
          </div>

          <div className="mb-6 flex gap-2 bg-black/50 border border-white/10 p-1 backdrop-blur-md">
            <button
              className={`flex-1 px-3 py-2 text-sm font-medium transition-all duration-300 ${
                authMode === "login" ? "bg-[#00f3ff] text-black" : "text-white/60 hover:text-white"
              }`}
              type="button"
              onClick={() => {
                setAuthMode("login");
                setErrorText(null);
                setStatusText(null);
              }}
            >
              Login
            </button>
            <button
              className={`flex-1 px-3 py-2 text-sm font-medium transition-all duration-300 ${
                authMode === "register" ? "bg-[#00f3ff] text-black" : "text-white/60 hover:text-white"
              }`}
              type="button"
              onClick={() => {
                setAuthMode("register");
                setErrorText(null);
                setStatusText(null);
              }}
            >
              Register
            </button>
          </div>

          <form
            className="space-y-5"
            onSubmit={authMode === "register" ? handleRegister : handleLogin}
          >
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wider text-[#00f3ff]/80 font-mono">Username</span>
              <input
                type="text"
                value={username}
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
                className="w-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white outline-none focus:border-[#00f3ff] focus:ring-1 focus:ring-[#00f3ff] transition-all duration-300 backdrop-blur-sm"
              />
            </label>

            {authMode === "register" ? (
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wider text-[#00f3ff]/80 font-mono">Display name</span>
                <input
                  type="text"
                  value={displayName}
                  autoComplete="name"
                  onChange={(event) => setDisplayName(event.target.value)}
                  className="w-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white outline-none focus:border-[#00f3ff] focus:ring-1 focus:ring-[#00f3ff] transition-all duration-300 backdrop-blur-sm"
                />
              </label>
            ) : null}

            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wider text-[#00f3ff]/80 font-mono">Password</span>
              <input
                type="password"
                value={password}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white outline-none focus:border-[#00f3ff] focus:ring-1 focus:ring-[#00f3ff] transition-all duration-300 backdrop-blur-sm"
              />
            </label>

            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-[#00f3ff] px-4 py-3 text-sm font-bold uppercase tracking-wider text-black hover:bg-[#00f3ff]/80 disabled:opacity-50 transition-all duration-300 font-mono mt-4"
            >
              {authLoading ? "Processing..." : authMode === "register" ? "Initialize Secure Node" : "Access Terminal"}
            </button>
          </form>

          {errorText ? <p className="mt-5 text-xs text-[#ff00ff] text-center uppercase tracking-wide font-mono">{errorText}</p> : null}
          {statusText ? <p className="mt-5 text-xs text-[#00ff00] text-center uppercase tracking-wide font-mono">{statusText}</p> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-black text-white relative">
      <style>{autofillStyles}</style>
      <div className="mx-auto flex h-screen w-full max-w-7xl flex-col md:flex-row relative z-10 p-0 md:p-4 gap-0 md:gap-4">
        <aside
          className={`w-full border border-white/10 bg-black/40 backdrop-blur-2xl md:w-96 md:rounded-xl overflow-hidden transition-all duration-300 ${
            mobileActivePane === "chat" ? "hidden md:flex md:flex-col" : "flex flex-col"
          }`}
        >
          <div className="border-b border-white/10 p-5 bg-black/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold tracking-wider text-[#00f3ff] font-mono">{session.user.display_name}</h2>
                <p className="text-xs text-white/50 uppercase tracking-widest mt-1 font-mono">@{session.user.username}</p>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="border border-white/20 bg-black/50 px-3 py-2 text-xs font-medium text-white hover:bg-white/10 hover:text-[#00f3ff] transition-colors duration-300 font-mono"
              >
                LOGOUT
              </button>
            </div>
            <p className="mt-3 text-[10px] uppercase tracking-widest text-[#00ff00] font-mono">
              {wsStatus === "online" ? "System Online // Encrypted" : "Offline Fallback // Encrypted"}
            </p>
          </div>

          <form className="border-b border-white/10 p-5 bg-black/20" onSubmit={handleSearchUsers}>
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Locate user..."
                className="w-full border border-white/10 bg-black/60 px-3 py-2 text-sm text-white outline-none focus:border-[#00f3ff] focus:ring-1 focus:ring-[#00f3ff] transition-all duration-300 backdrop-blur-sm placeholder:text-white/30 font-mono"
              />
              <button
                type="submit"
                disabled={searchLoading}
                className="bg-white/10 border border-white/10 px-4 py-2 text-xs font-bold text-[#00f3ff] uppercase tracking-wider hover:bg-[#00f3ff] hover:text-black disabled:opacity-50 transition-all duration-300 font-mono"
              >
                {searchLoading ? "..." : "Scan"}
              </button>
            </div>
            {searchResults.length > 0 ? (
              <div className="mt-4 max-h-40 overflow-y-auto border border-white/10 bg-black/80 backdrop-blur-md">
                {searchResults.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => handlePickConversation(result)}
                    className="flex w-full items-center justify-between border-b border-white/10 px-4 py-3 text-left text-sm last:border-b-0 hover:bg-white/5 transition-colors duration-300"
                  >
                    <span className="font-medium text-[#00f3ff] font-mono">{result.display_name}</span>
                    <span className="text-xs text-white/40 uppercase tracking-wider font-mono">@{result.username}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </form>

          <div className="overflow-y-auto flex-1">
            {conversationsLoading ? (
              <p className="p-5 text-xs text-white/40 uppercase tracking-widest text-center mt-4 font-mono">Loading active links...</p>
            ) : conversations.length === 0 ? (
              <p className="p-5 text-xs text-white/40 uppercase tracking-widest text-center mt-4 font-mono">No active links found.</p>
            ) : (
              conversations.map((conversation) => (
                (() => {
                  const unreadCount = unreadByUser[conversation.user_id] ?? 0;
                  return (
                <button
                  key={conversation.user_id}
                  type="button"
                  onClick={() => {
                    selectConversation(conversation.user_id);
                  }}
                  className={`w-full border-b border-white/10 px-5 py-4 text-left transition-all duration-300 ${
                    selectedUserId === conversation.user_id ? "bg-[#00f3ff]/10 border-l-2 border-l-[#00f3ff]" : "hover:bg-white/5 border-l-2 border-l-transparent"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-bold tracking-wide font-mono ${selectedUserId === conversation.user_id ? "text-[#00f3ff]" : "text-white"}`}>{conversation.display_name}</span>
                    <div className="flex items-center gap-2">
                      {unreadCount > 0 ? (
                        <span className="min-w-5 rounded-full bg-[#00f3ff] px-1.5 py-0.5 text-center text-[10px] font-bold text-black">
                          {unreadCount > 99 ? "99+" : unreadCount}
                        </span>
                      ) : null}
                      <span className="text-[10px] text-white/40 uppercase tracking-wider font-mono">
                        {conversation.last_message_at ? formatTimestamp(conversation.last_message_at) : ""}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-white/40 mt-1 uppercase tracking-widest font-mono">@{conversation.username}</p>
                </button>
                  );
                })()
              ))
            )}
          </div>
        </aside>

        <main
          className={`flex-1 flex-col border border-white/10 bg-black/40 backdrop-blur-2xl md:rounded-xl overflow-hidden transition-all duration-300 ${
            mobileActivePane === "list" ? "hidden md:flex" : "flex"
          }`}
        >
          <header className="border-b border-white/10 px-6 py-5 bg-black/20 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileActivePane("list")}
                className="relative border border-white/20 bg-black/50 px-3 py-2 text-xs font-medium text-white hover:bg-white/10 hover:text-[#00f3ff] transition-colors duration-300 font-mono md:hidden"
              >
                BACK
                {hasUnreadOutsideSelectedConversation ? (
                  <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[#00f3ff]" />
                ) : null}
              </button>
              <div>
              <h3 className="text-lg font-bold tracking-wider text-[#00f3ff] font-mono">
                {selectedConversation ? selectedConversation.display_name : "NO SIGNAL"}
              </h3>
              <p className="text-[10px] text-white/50 uppercase tracking-widest mt-1 font-mono">Secure transmission node</p>
              </div>
            </div>
            {selectedConversation && (
              <div className="h-2 w-2 bg-[#00f3ff] animate-pulse"></div>
            )}
          </header>

          <section
            ref={messagesViewportRef}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-6 md:px-8 bg-black/30"
          >
            {!selectedUserId ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-sm text-white/30 uppercase tracking-widest border border-white/10 px-6 py-3 bg-black/50 backdrop-blur-md font-mono">Initiate connection to begin.</p>
              </div>
            ) : messagesLoading ? (
              <p className="text-xs text-[#00f3ff]/50 uppercase tracking-widest text-center mt-4 font-mono">Decrypting stream...</p>
            ) : selectedMessages.length === 0 ? (
              <p className="text-xs text-white/30 uppercase tracking-widest text-center mt-4 font-mono">No messages in this secure thread yet.</p>
            ) : (
              selectedMessages.map((message) => {
                const isOwnMessage = message.fromUserId === session.user.id;
                return (
                  <div
                    key={message.id}
                    className={`max-w-[75%] px-5 py-3 backdrop-blur-md border ${
                      isOwnMessage
                        ? "ml-auto bg-[#00f3ff]/10 text-[#00f3ff] border-[#00f3ff]/30"
                        : "mr-auto bg-white/5 text-white border-white/10"
                    } transition-all duration-300 hover:bg-black/80`}
                  >
                    <p className="text-sm leading-relaxed tracking-wide font-light">{message.text}</p>
                    <div className="mt-2 flex items-center gap-2 text-[9px] uppercase tracking-widest opacity-60 justify-end font-mono">
                      <span>{formatTimestamp(message.createdAt)}</span>
                      <span>•</span>
                      <span className={message.failedToDecrypt ? "text-[#ff00ff]" : "text-[#00ff00]"}>{message.failedToDecrypt ? "ERR" : "SEC"}</span>
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <form
            className="border-t border-white/10 p-4 md:p-6 bg-black/20"
            onSubmit={handleSendMessage}
          >
            <div className="flex gap-3">
              <input
                type="text"
                value={composeMessage}
                disabled={!selectedUserId || sendLoading}
                onChange={(event) => {
                  if (!selectedUserId) {
                    return;
                  }
                  const value = event.target.value;
                  setComposeMessageByUser((prev) => ({ ...prev, [selectedUserId]: value }));
                }}
                placeholder={selectedUserId ? "Type payload..." : "Target required"}
                className="w-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white outline-none focus:border-[#00f3ff] focus:ring-1 focus:ring-[#00f3ff] disabled:opacity-50 backdrop-blur-sm transition-all duration-300 placeholder:text-white/30 placeholder:uppercase placeholder:tracking-widest font-mono"
              />
              <button
                type="submit"
                disabled={!selectedUserId || sendLoading || !composeMessage.trim()}
                className="bg-[#00f3ff] px-6 py-3 text-sm font-bold text-black uppercase tracking-wider hover:bg-[#00f3ff]/80 disabled:opacity-50 disabled:bg-white/10 disabled:text-white/30 transition-all duration-300 font-mono"
              >
                {sendLoading ? "..." : "Tx"}
              </button>
            </div>
            {errorText ? <p className="mt-3 text-[10px] uppercase tracking-widest text-[#ff00ff] font-mono">{errorText}</p> : null}
            {statusText ? <p className="mt-3 text-[10px] uppercase tracking-widest text-[#00ff00] font-mono">{statusText}</p> : null}
          </form>
        </main>
      </div>
    </div>
  );
}
