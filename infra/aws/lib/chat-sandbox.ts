/**
 * Each execution environment reserves 10 GB, so concurrency is what bounds the
 * cost of this function. One chat runs its commands one at a time, so this is a
 * ceiling on simultaneously computing chats rather than on commands.
 */
export const CHAT_SANDBOX_RESERVED_CONCURRENCY = 5;
