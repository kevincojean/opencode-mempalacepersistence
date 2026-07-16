// ---------------------------------------------------------------------------
// Prompt injection patterns used by oh-my-openagent (OMO)
//
// When stripInjectedPrompts is enabled, all of these are removed from the
// user message text before it's used as a search query.
//
// Sources:
//   https://github.com/code-yeongyu/oh-my-openagent
//   - packages/utils/src/internal-initiator-marker.ts
//   - packages/omo-opencode/src/shared/system-directive.ts
//   - packages/omo-opencode/src/hooks/atlas/system-reminder-templates.ts
//   - packages/omo-opencode/src/hooks/keyword-detector/constants.ts
//   - packages/omo-opencode/src/features/monitor/envelope.ts
//   - packages/omo-opencode/src/plugin/messages-transform.ts
//   - packages/omo-opencode/src/agents/sisyphus/*.ts
//   - prompts-core/prompts/ultrawork/*.md
//   - prompts/mode/*.md
// ---------------------------------------------------------------------------

// XML/HTML-style multi-line blocks (strip first — they can contain other patterns)
const OMO_SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const OMO_ULTRAWORK_MODE = /<ultrawork-mode>[\s\S]*?<\/ultrawork-mode>/g
const OMO_HYPERPLAN_MODE = /<hyperplan-mode>[\s\S]*?<\/hyperplan-mode>/g
const OMO_HYPERPLAN_ULTRAWORK_MODE = /<hyperplan-ultrawork-mode>[\s\S]*?<\/hyperplan-ultrawork-mode>/g
const OMO_PLANNING_CONTEXT = /<planning-context[^>]*>[\s\S]*?<\/planning-context>/g

// Bracket-enclosed multi-line blocks
const OMO_MONITOR_OUTPUT = /\[OMO MONITOR OUTPUT\][\s\S]*?\[END OMO MONITOR OUTPUT\]/g

// HTML comment sentinels
const OMO_INITIATOR_SENTINEL = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/g
const OMO_NOREPLY_SENTINEL = /<!--\s*OMO_INTERNAL_NOREPLY\s*-->/g

// System directive bracket markers
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - RALPH LOOP]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - DELEGATION REQUIRED]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - SINGLE TASK ONLY]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - CONTEXT WINDOW MONITOR]
// [SYSTEM DIRECTIVE: OH-MY-OPENCODE - PROMETHEUS READ-ONLY]
const OMO_SYSTEM_DIRECTIVE = /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/g

// Mode directive markers (single-line brackets)
const OMO_ANALYZE_MODE = /^\s*\[analyze-mode\]\s*$/gm
const OMO_TEAM_MODE = /^\s*\[team-mode\]\s*$/gm

// Search directive block (prologue before structured task prompts)
const OMO_SEARCH_MODE = /^\s*\[search-mode\]\s*$/gm
const OMO_DIRECTIVE_MAXIMIZE = /^\s*MAXIMIZE SEARCH EFFORT.*$/gm
const OMO_DIRECTIVE_NEVER = /^\s*NEVER\s+stop\s+at\s+first\s+result.*$/gmi
const OMO_DIRECTIVE_PLUS = /^\s*Plus\s+direct\s+tools:.*$/gmi

// ---------------------------------------------------------------------------
// Boilerplate TEXT phrases (not just structural markers)
// These are the prose that OMO injects as mode descriptions, section headers,
// and instructional text. After stripping structural markers via the patterns
// above, these phrases remain and pollute the search query.
// ---------------------------------------------------------------------------

// analyze-mode boilerplate prose
// NOTE: No ^/$ anchors — after previous replacements collapse lines, these
// phrases may appear mid-text rather than on isolated lines.
const OMO_ANALYZE_HEADER = /ANALYSIS MODE\.\s+Gather context before diving deep:?\s*/gi
const OMO_CONTEXT_GATHERING = /(?:CONTEXT\s+)?GATHERING\s*\(parallel\):?\s*/gi
const OMO_IF_COMPLEX = /IF COMPLEX\s*-\s*DO NOT STRUGGLE ALONE\.\s*Consult specialists:?\s*/gi
const OMO_SYNTHESIZE = /SYNTHESIZE findings before proceeding\.?\s*/gi

// search-mode boilerplate prose (supplemental to OMO_DIRECTIVE_MAXIMIZE which
// may not match all variants)
const OMO_LAUNCH_AGENTS = /Launch multiple background agents IN PARALLEL:?\s*/gi

// OMO delegation instructions (injected into task prompts)
const OMO_MANDATORY_DELEGATE = /MANDATORY\s+delegate_task\s+params:\s*ALWAYS\s+include\s+load_skills[^.]*\.?\s*/gi
const OMO_EVALUATE_SKILLS = /Evaluate available skills before dispatch[^.]*\.?\s*/gi
const OMO_EXAMPLE_DELEGATE = /Example:\s*delegate_task\([^)]*\)\s*/gi

// team-mode / hyperplan-mode boilerplate
const OMO_TEAM_MODE_TEXT = /\[team-mode\][^\n]*/gi
const OMO_HYPERPLAN_TEXT = /Hyperplan mode activated[^\n]*/gi

// Recovery/continuation markers
const OMO_INTERNAL_RECOVERY = /^\s*\[internal\]\s+Continue\s+from\s+the\s+previous\s+assistant\s+state\.\s*/gm
const OMO_SESSION_RECOVERY = /^\s*\[session recovered\s*-\s*continuing previous task\]\s*/gmi

// Task prompt section headers
// Variants: [CONTEXT]:, [CONTEXT], CONTEXT:, CONTEXT (standalone line)
const OMO_BLOCK_HEADER = /^\s*\[?(?:CONTEXT|GOAL|REQUEST|DOWNSTREAM)\]?\s*:?\s*$/im
const OMO_INLINE_HEADER = /^\s*\[?(?:CONTEXT|GOAL|REQUEST|DOWNSTREAM)\]?\s*:?\s+/im

// Structured lists inside task prompts
const OMO_NUMBERED_LIST = /^\s*\d+\.\s.*$/gm
const OMO_BULLET_LIST = /^\s*[-*]\s.*$/gm

// Separators
const OMO_SEPARATOR = /^\s*---\s*$/gm

export function stripInjectedPrompts(text: string): string {
  return text
    // Multi-line blocks first (may contain other patterns inside)
    .replace(OMO_SYSTEM_REMINDER, "")
    .replace(OMO_ULTRAWORK_MODE, "")
    .replace(OMO_HYPERPLAN_MODE, "")
    .replace(OMO_HYPERPLAN_ULTRAWORK_MODE, "")
    .replace(OMO_PLANNING_CONTEXT, "")
    .replace(OMO_MONITOR_OUTPUT, "")
    // Single-line sentinels
    .replace(OMO_INITIATOR_SENTINEL, "")
    .replace(OMO_NOREPLY_SENTINEL, "")
    // System directives
    .replace(OMO_SYSTEM_DIRECTIVE, "")
    // Mode markers
    .replace(OMO_ANALYZE_MODE, "")
    .replace(OMO_TEAM_MODE, "")
    .replace(OMO_SEARCH_MODE, "")
    .replace(OMO_DIRECTIVE_MAXIMIZE, "")
    .replace(OMO_DIRECTIVE_NEVER, "")
    .replace(OMO_DIRECTIVE_PLUS, "")
    // Recovery markers
    .replace(OMO_INTERNAL_RECOVERY, "")
    .replace(OMO_SESSION_RECOVERY, "")
    // Task prompt section headers
    .replace(OMO_BLOCK_HEADER, "")
    .replace(OMO_INLINE_HEADER, "")
    // Structured lists
    .replace(OMO_NUMBERED_LIST, "")
    .replace(OMO_BULLET_LIST, "")
    // Separators
    .replace(OMO_SEPARATOR, "")
    // Boilerplate TEXT phrases (after markers are gone, these prose lines remain)
    .replace(OMO_ANALYZE_HEADER, "")
    .replace(OMO_CONTEXT_GATHERING, "")
    .replace(OMO_IF_COMPLEX, "")
    .replace(OMO_SYNTHESIZE, "")
    .replace(OMO_LAUNCH_AGENTS, "")
    .replace(OMO_MANDATORY_DELEGATE, "")
    .replace(OMO_EVALUATE_SKILLS, "")
    .replace(OMO_EXAMPLE_DELEGATE, "")
    .replace(OMO_TEAM_MODE_TEXT, "")
    .replace(OMO_HYPERPLAN_TEXT, "")
}
