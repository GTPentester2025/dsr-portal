export interface EmailAttachment {
  filename: string;
  /** Base64-encoded content. */
  content: string;
  contentType?: string;
}

export interface SendTransactionalOptions {
  /** Requester's language; falls back to English when absent. */
  language?: string;
  replyTo?: string;
  fromDisplayName?: string;
}

export interface SendAsUserArgs {
  fromMailbox: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** HTML body. */
  body: string;
  attachments?: EmailAttachment[];
}

export interface SendResult {
  providerMessageId: string;
  /** The message exactly as rendered and sent, for `email_log`. Absent on
      paths that take a body from the caller, which already has it. */
  subject?: string;
  html?: string;
}

export interface ConnectionStatus {
  ok: boolean;
  provider: string;
  detail: string;
}

/**
 * Spec §4 — the single seam between the app and any mail backend.
 * No provider-specific logic may exist outside the adapter implementations.
 */
export interface EmailProvider {
  sendTransactional(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    options?: SendTransactionalOptions,
  ): Promise<SendResult>;

  sendAsUser(args: SendAsUserArgs): Promise<SendResult>;

  verifyConnection(): Promise<ConnectionStatus>;

  /** Name of the adapter that will handle the next send, for `email_log`. */
  activeName(): string;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
