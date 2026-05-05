const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,24}$/;

export function validateUsername(username: string): string | null {
  if (!USERNAME_REGEX.test(username)) {
    return "Username must be 3-24 chars and only letters, numbers, underscore.";
  }
  return null;
}

export function validateDisplayName(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (trimmed.length < 2 || trimmed.length > 48) {
    return "Display name must be between 2 and 48 characters.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 10) {
    return "Password must be at least 10 characters.";
  }
  return null;
}

export function validateSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    return "Search query must be 1-64 characters.";
  }
  return null;
}

export function validateMessageText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 1) {
    return "Message cannot be empty.";
  }
  if (trimmed.length > 4000) {
    return "Message is too long.";
  }
  return null;
}

