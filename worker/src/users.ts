export interface DiscordInteraction {
  type: number;
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  message?: { id?: string; channel_id?: string; content?: string };
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    components?: { components?: { custom_id?: string; value?: string }[] }[];
  };
}

// The Discord user ids allowed to answer: ALLOWED_USER_IDS when it is set (comma-separated),
// else the application's owner as looked up from Discord, else nobody. Callers read the
// environment and the setup row on every call; nothing is cached.
export function allowedUserIds(override: string | undefined, ownerId: string | null): string[] {
  const listed = (override ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (listed.length) return listed;
  return ownerId ? [ownerId] : [];
}

export function isAllowedUser(i: DiscordInteraction, allowed: string[]): boolean {
  const userId = i.member?.user?.id ?? i.user?.id;
  return !!userId && allowed.includes(userId);
}
