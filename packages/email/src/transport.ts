import type { EmailMessage } from "./message";
import type { SendEmailResult } from "./send-result";

/**
 * The only seam between Doxa and an email provider. A new provider is one
 * class that implements this interface plus one entry in the provider registry.
 */
export interface EmailTransport {
  /** A stable name, such as `cloudflare`. It is stored with each delivery. */
  readonly provider: string;
  /**
   * Hands one message to the provider. Provider and network errors come back
   * as an `EmailFailure`; this method does not throw for them.
   */
  send(message: EmailMessage): Promise<SendEmailResult>;
}
