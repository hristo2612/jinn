# Connectors

Connectors are modular adapters that bridge external messaging platforms with {{portalName}}'s session manager.

## Connector Interface

```typescript
interface Connector {
  name: string;
  id: string;             // Connector instance id and registry key
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(sourceRef: string, text: string): Promise<void>;
  addReaction(sourceRef: string, emoji: string): Promise<void>;
  removeReaction(sourceRef: string, emoji: string): Promise<void>;
  editMessage(sourceRef: string, text: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
}

interface IncomingMessage {
  sourceRef: string;     // Unique identifier for routing
  text: string;          // Message content
  userId: string;        // Platform user ID
  userName: string;      // Display name
  connector: string;     // Connector instance id
}
```

## Telegram Provider Authentication

Provider authentication from Telegram is opt-in. Add `telegramAuth` under the
Telegram connector to enable it:

```yaml
connectors:
  telegram:
    botToken: ...
    allowFrom:
      - 123456789
    telegramAuth:
      enabled: true
      ownerUserIds:
        - 123456789
      flowTtlSeconds: 600
```

Every `ownerUserIds` entry must also appear in `allowFrom`. Invalid or
non-allow-listed owner IDs are ignored. Authentication commands are accepted
only in private chats and only from configured owners. With `telegramAuth`
absent or disabled, Telegram messages follow the normal connector path.
If no configured owner remains after that filtering, authentication stays disabled.

The supported commands are:

- `/auth_claude` — start Claude authentication.
- `/auth_codex` — start Codex device authentication.
- `/auth_status` — show the current Claude and Codex authentication status.
- `/auth_cancel` — stop active authentication flows.
- `/auth_input <code>` — explicit input form retained for compatibility. Codes
  match `AAAA-BBBB` or `AAAA-BBBBB`; provider tokens are not accepted. While one
  flow is active, the code or Claude loopback
  `http://localhost:<port>/callback?...` URL may also be sent as a standalone
  message. Jinn extracts Claude's one-time `code#state` value when both fields
  are present.

The space forms (`/auth claude`, `/auth codex`, `/auth status`,
`/auth cancel`, and `/auth input <code>`) are also supported. Secret-bearing
auth input is deleted best-effort after receipt. The CLI uses the gateway's
normal working directory and environment, so native npm/Homebrew installs use
their normal provider credential locations and Docker uses the paths configured
by the image.

## Slack Connector

Uses `@slack/bolt` with Socket Mode (no public URL required).

### Configuration

```yaml
connectors:
  slack:
    appToken: xapp-...    # Socket Mode app token
    botToken: xoxb-...    # Bot user OAuth token
```

### Thread Mapping

Slack messages are mapped to sessions based on conversation context:

| Slack Context | Source Ref Format | Session Behavior |
|---|---|---|
| Direct message | `slack:dm:<userId>` | One session per DM user |
| Channel root message | `slack:<channelId>` | One session per channel |
| Thread reply | `slack:<channelId>:<threadTs>` | One session per thread |

### Reaction Workflow

Reactions provide visual feedback during processing:

1. Message received → add :eyes: reaction (acknowledged)
2. Engine processing...
3. On success → remove :eyes:, add :white_check_mark:
4. On error → remove :eyes:, add :x:

### Employee Routing

- Default: messages route to the default employee ({{portalName}})
- `@mention`: messages mentioning a specific employee name route to that employee
- Thread continuity: replies in a thread continue with the same employee

## Named Instances

`connectors.instances[]` declares connectors explicitly, so you can run several of the
same type — each with its own credentials and its own employee.

```yaml
connectors:
  instances:
    - id: slack-support      # unique connector id
      type: slack            # slack | discord | telegram | whatsapp
      employee: support-lead # optional — who handles messages from this connector
      appToken: xapp-...     # remaining keys are the type's own config
      botToken: xoxb-...
    - id: telegram-ops
      type: telegram
      botToken: ...
```

Both config forms produce the same thing at runtime: a top-level connector
(`connectors.slack`, `connectors.discord`, `connectors.telegram`, `connectors.whatsapp`)
is simply an instance whose `id` defaults to its type. So `connectors.slack` and an
instance with `id: slack` are the same connector — the duplicate is skipped, as is any
entry missing `id` or `type`.

Connector ids are what the rest of the gateway addresses:

- `POST /api/connectors/<id>/send` and the `send_connector_message` company tool
- the `## Available connectors` list in every session's context
- `POST /api/connectors/reload`, which stops every running connector and restarts it
  from the current `config.yaml` — regardless of which form declared it

## Future Connectors

The connector interface is designed for additional platforms:
- **Discord**: Bot integration via discord.js
- **iMessage**: macOS-only via AppleScript bridge
- **Web UI**: Built-in, served by the HTTP server
- **CLI**: Direct terminal input/output
