/** What `cogmo setup --reset` clears. */
export const RESET_SCOPES = ["secrets", "channels", "all"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];
