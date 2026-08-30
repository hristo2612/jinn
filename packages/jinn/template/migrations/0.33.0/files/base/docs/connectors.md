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
