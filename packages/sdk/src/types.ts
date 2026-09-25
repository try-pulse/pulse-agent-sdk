// Names for the generated wire types. Everything here is a re-export or a narrowing of
// ./generated/*, which is produced from the OpenAPI snapshots in specs/; no wire shape
// is written by hand.
import type { components as ApiComponents, operations as ApiOperations } from "./generated/pulse-api.js";
import type { components as SessionComponents } from "./generated/agent-sessions.js";

type Api = ApiComponents["schemas"];
type Sessions = SessionComponents["schemas"];

// Agent Session API (pulse-agent docs/openapi/agent-sessions.yaml)
export type AgentSession = Sessions["AgentSession"];
export type AgentSessionState = Sessions["AgentSessionState"];
export type AgentSessionEndReason = Sessions["AgentSessionEndReason"];
export type AgentSessionPage = Sessions["AgentSessionPage"];
export type AgentSessionCreate = Sessions["AgentSessionCreate"];
export type AgentSessionUpdate = Sessions["AgentSessionUpdate"];
export type AgentActivity = Sessions["AgentActivity"];
export type AgentActivityPage = Sessions["AgentActivityPage"];
export type AgentActivityCreate = Sessions["AgentActivityCreate"];
export type AgentActivityAuthor = Sessions["AgentActivityAuthor"];
export type ThoughtContent = Sessions["ThoughtContent"];
export type ActionContent = Sessions["ActionContent"];
export type ElicitationContent = Sessions["ElicitationContent"];
export type ResponseContent = Sessions["ResponseContent"];
export type ErrorContent = Sessions["ErrorContent"];
export type PromptContent = Sessions["PromptContent"];
export type PlanItem = Sessions["PlanItem"];
export type ExternalUrl = Sessions["ExternalUrl"];
export type SelectSignalMetadata = Sessions["SelectSignalMetadata"];
export type SelectOption = SelectSignalMetadata["options"][number];
export type AuthSignalMetadata = Sessions["AuthSignalMetadata"];
export type SessionApiError = Sessions["Error"];

// App webhooks (pulse-api components/schemas/app-webhook-payload.yaml)
export type AppWebhookEnvelope = Api["AppWebhookEnvelope"];
export type AppWebhookEventType = Api["AppWebhookEventType"];
export type AppWebhookAction = Api["AppWebhookAction"];
export type WebhookActor = Api["WebhookActor"];
export type AgentSessionEventCreatedData = Api["AgentSessionEventCreatedData"];
export type AgentSessionEventPromptedData = Api["AgentSessionEventPromptedData"];
export type PermissionChangeData = Api["PermissionChangeData"];
export type OAuthAppRevokedData = Api["OAuthAppRevokedData"];
export type PromptedActivity = Api["PromptedActivity"];
export type AgentSessionComment = Api["AgentSessionComment"];
export type AgentSessionGuidance = Api["AgentSessionGuidance"];
export type WebhookIssueData = Api["WebhookIssueData"];
export type WebhookCommentData = Api["WebhookCommentData"];
export type WebhookProjectData = Api["WebhookProjectData"];
export type AppWebhookPingData = Api["AppWebhookPingData"];

// The schema makes installation_id / app_user_id optional only because Ping omits them;
// its description says every other type always carries both, so installation events
// narrow them back to required.
type Narrow<T extends AppWebhookEventType, A extends AppWebhookAction, D> = Omit<
  AppWebhookEnvelope,
  "type" | "action" | "data" | "installation_id" | "app_user_id"
> & {
  type: T;
  action: A;
  data: D;
  installation_id: NonNullable<AppWebhookEnvelope["installation_id"]>;
  app_user_id: NonNullable<AppWebhookEnvelope["app_user_id"]>;
};

/** `POST /agent-apps/{app_id}/webhook/test`: no installation, no event_id, never retried. */
export type PingEvent = Omit<AppWebhookEnvelope, "type" | "action" | "data" | "installation_id" | "app_user_id"> & {
  type: "Ping";
  action: "create";
  data: AppWebhookPingData;
};

export type AgentSessionCreatedEvent = Narrow<"AgentSessionEvent", "created", AgentSessionEventCreatedData>;
export type AgentSessionPromptedEvent = Narrow<"AgentSessionEvent", "prompted", AgentSessionEventPromptedData>;
export type PermissionChangeEvent = Narrow<"PermissionChange", "teamAccessChanged", PermissionChangeData>;
export type OAuthAppRevokedEvent = Narrow<"OAuthApp", "revoked", OAuthAppRevokedData>;
export type DataEvent =
  | Narrow<"Issue", "create" | "update" | "remove", WebhookIssueData>
  | Narrow<"Comment", "create" | "update" | "remove", WebhookCommentData>
  | Narrow<"Project", "create" | "update" | "remove", WebhookProjectData>;

// pulse-api REST surface an app uses
export type ApiError = Api["Error"];
export type MeResponse = Api["MeResponse"];
export type Issue = Api["Issue"];
/** pulse-api answers the issue endpoints with the Issue itself; kept as an alias. */
export type IssueResponse = Issue;
export type IssueStatus = Api["IssueStatus"];
export type UpdateIssueRequest = Api["UpdateIssueRequest"];
/** The statuses an agent app may move an issue to (`APP_STATUS_FORBIDDEN` otherwise). */
export type AppIssueStatus = Extract<IssueStatus, "in_progress" | "qa">;
export type OAuthScope = Api["OAuthScope"];
export type AgentAppScope = Api["AgentAppScope"];
export type OAuthTokenResponse = ApiOperations["oauthToken"]["responses"][200]["content"]["application/json"];
export type OAuthErrorBody = Api["OAuthError"];
