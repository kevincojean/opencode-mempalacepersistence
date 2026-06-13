Feature: MemPalace Persistence Plugin
  As an OpenCode user with the mempalace-persistence plugin installed
  I want conversations to be automatically saved to MemPalace and relevant memories injected
  So that the model has persistent context across sessions

  Background:
    Given the plugin is registered in OpenCode config and enabled
    And autoInjectContext is enabled in plugin-config.json
    And a test identity is set in identity.txt
    And a test MemPalace palace is initialized

  # ─────────────────────────────────────────────
  #  Plugin Lifecycle & Initialization
  # ─────────────────────────────────────────────

  @init
  Scenario: Plugin loads without errors
    Given the plugin is registered in opencode.jsonc
    When OpenCode starts via `opencode run`
    Then the process exits cleanly with status 0
    And the plugin initializes without throwing

  @init
  Scenario: Plugin respects autoInjectContext: false
    Given plugin-config.json contains { "autoInjectContext": false }
    When `opencode run --format json "Hello world"` completes
    Then the output JSON contains no synthetic identity or recall parts

  @init
  Scenario: Plugin handles missing identity file gracefully
    Given identity.txt does not exist
    When the plugin loads
    Then no crash occurs
    And the first user message has no [MemPalace Identity] injection

  # ─────────────────────────────────────────────
  #  Debug Logging
  # ─────────────────────────────────────────────

  @logging
  Scenario: Debug logging is activated by environment variable
    Given OPENCODE_MEMPALACE_DEBUG=1 is set
    When a message is sent via `opencode run`
    Then log entries appear in /tmp/opencode-mempalace.log
    And each log entry starts with an ISO timestamp

  @logging
  Scenario: Without debug flag, no log output is produced
    Given OPENCODE_MEMPALACE_DEBUG is not set
    When plugin operations occur
    Then /tmp/opencode-mempalace.log is not created or modified

  # ─────────────────────────────────────────────
  #  Identity Injection (auto-inject mode)
  # ─────────────────────────────────────────────

  @injection
  Scenario: First user message injects identity
    Given autoInjectContext is enabled
    And identity.txt contains "I am Kevin, a software engineer"
    When `opencode run --format json "What is my role?"` completes
    Then the first user message in the session includes a synthetic part
    And that part contains "[MemPalace Identity]"
    And that part contains "I am Kevin, a software engineer"

  @injection
  Scenario: Identity is injected only once per session
    Given autoInjectContext is enabled
    When a session has 2 or more consecutive user messages
    Then only the first user message has an identity-injection synthetic part
    And subsequent messages have no identity block

  @injection
  Scenario: No identity injection when identity file is empty
    Given identity.txt is empty or contains only whitespace
    When `opencode run --format json "Who am I?"` completes
    Then no [MemPalace Identity] block appears in the output
    And no error occurs

  # ─────────────────────────────────────────────
  #  Memory Search & Injection (auto-inject mode)
  # ─────────────────────────────────────────────

  @injection @search
  Scenario: User message triggers memory search
    Given autoInjectContext is enabled
    When `opencode run --format json "What do you remember about my setup?"` completes
    Then the output contains a [MemPalace Recall] synthetic part
    And the recall text references previously mined memories

  @injection @search
  Scenario: Short messages skip memory search
    Given autoInjectContext is enabled
    When `opencode run --format json "Hi"` completes
    Then no [MemPalace Recall] block appears in the output

  @injection @search
  Scenario: Repeated queries within 3 seconds use cached results
    Given autoInjectContext is enabled
    When two identical queries are sent within 3 seconds of each other
    Then the second invocation does not run `mempalace search` again
    And both messages receive the same recall text

  @injection @search
  Scenario: Empty search results produce no injection
    Given the test palace is empty (no drawers)
    When `opencode run --format json "Some long query string here"` completes
    Then no [MemPalace Recall] block is added

  @injection @search
  Scenario: Search results are truncated to 900 characters
    Given the test palace contains many relevant documents
    When a query triggers a large memory recall
    Then the injected [MemPalace Recall] text is at most 900 characters

  # ─────────────────────────────────────────────
  #  Session Mining (chat.message hook)
  # ─────────────────────────────────────────────

  @mining
  Scenario: User message triggers session mining
    When `opencode run --format json "Remember this for later"` completes
    Then within 5 seconds the session is mined from OpenCode DB
    And a conversation text file appears in /tmp/oc-sessions/
    And `mempalace mine` is invoked on that file

  @mining
  Scenario: First message alone does not trigger mining
    Given this is a brand new session
    When the first user message is sent
    Then no file is written to /tmp/oc-sessions/
    And no mempalace mine command executes

  @mining
  Scenario: Mined conversation has correct structure
    When a multi-turn session is mined
    Then the output file at /tmp/oc-sessions/session_*.txt contains:
      | Field        | Expected                          |
      | Header       | "# Session <sessionId>"           |
      | Date         | "Date: YYYY-MM-DD"                |
      | Role markers | "## USER — HH:MM:SS" or "## ASSISTANT — HH:MM:SS" |
      | Content      | Each message's text verbatim       |
    And the filename follows the pattern session_{first8}_{hash12}.txt

  @mining
  Scenario: Mining lock prevents concurrent operations
    Given a mining operation is already in progress
    When a new user message triggers another mine attempt
    Then the second mine is skipped
    And only one mempalace mine process runs at a time

  @mining
  Scenario: Successful mining cleans up temp file
    Given a session was successfully mined
    Then the temp file in /tmp/oc-sessions/ is deleted
    And the conversation is searchable via `mempalace search`

  @mining
  Scenario: Mining failure leaves temp file for debugging
    Given mempalace mine fails
    Then the temp conversation file remains in /tmp/oc-sessions/
    And miningLock is released

  @mining @retry
  Scenario: Mining is retried on lock contention
    Given a mining operation is already in progress
    And the palace is locked by another mempalace mine process
    When a new user message triggers another mine attempt
    Then the failed mine is queued for retry
    And a "Queued, retrying..." toast is shown
    And after the lock releases, the queued session is mined successfully
    And the session is searchable via `mempalace search`

  # ─────────────────────────────────────────────
  #  Database & Export Verification
  # ─────────────────────────────────────────────

  @sqlite @mining
  Scenario: Mined session is visible in OpenCode export
    Given a session was created via `opencode run`
    When `opencode export <session-id>` is run
    Then the export JSON contains the expected user and assistant messages
    And the message order is preserved

  @sqlite @mining
  Scenario: Plugin handles corrupt DB rows gracefully
    Given the OpenCode DB contains a message with invalid JSON in its data field
    When mining runs
    Then the corrupt row is silently skipped
    And valid messages are still processed successfully

  # ─────────────────────────────────────────────
  #  Session Idle
  # ─────────────────────────────────────────────

  @idle
  Scenario: Session idle event is logged and ignored
    When the session goes idle
    Then the plugin logs "idle event ignored" to the debug log
    And no mining or other side effects occur

  # ─────────────────────────────────────────────
  #  Configuration
  # ─────────────────────────────────────────────

  @config
  Scenario: Plugin reads config from plugin-config.json
    Given plugin-config.json contains autoInjectContext: true
    When the plugin initializes
    Then auto-inject is enabled

  @config
  Scenario: Plugin handles invalid JSON in config gracefully
    Given plugin-config.json contains malformed JSON
    When the plugin initializes
    Then auto-inject defaults to false
    And no crash occurs

  @config
  Scenario: Plugin handles missing config file
    Given plugin-config.json does not exist
    When the plugin initializes
    Then auto-inject defaults to false
    And no crash occurs

  # ─────────────────────────────────────────────
  #  Memory Storage Verification
  # ─────────────────────────────────────────────

  @storage
  Scenario: Mined memory is searchable via MemPalace
    Given a multi-turn session was successfully mined
    When `mempalace search <text from the session>` is run against the test palace
    Then the session content appears in search results

  @storage
  Scenario: Mined memory preserves role and timestamp
    Given a session was mined
    When the mined content is inspected
    Then it contains "## USER —" and "## ASSISTANT —" markers with timestamps
    And the message content is preserved verbatim
