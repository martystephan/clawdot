export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  /** HTTPS page with no remote link — direct ws:// is blocked as mixed
   * content, so there is nothing to connect to until the device pairs. */
  | "unpaired";
