const OMO_BLOCK_HEADER = /^\s*\[?(?:CONTEXT|GOAL|REQUEST|DOWNSTREAM)\]?\s*:?\s*$/im
const OMO_INLINE_HEADER = /^\s*\[?(?:CONTEXT|GOAL|REQUEST|DOWNSTREAM)\]?\s*:/im
const OMO_SENTINEL = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/g
const OMO_SEARCH_MODE = /^\s*\[search-mode\]\s*$/gm
const OMO_DIRECTIVE = /^\s*MAXIMIZE SEARCH EFFORT.*$/gm
const OMO_NUMBERED_LIST = /^\s*\d+\.\s.*$/gm
const OMO_BULLET_LIST = /^\s*[-*]\s.*$/gm

export function stripInjectedPrompts(text: string): string {
  return text
    .replace(OMO_SENTINEL, "")
    .replace(OMO_SEARCH_MODE, "")
    .replace(OMO_DIRECTIVE, "")
    .replace(OMO_BLOCK_HEADER, "")
    .replace(OMO_INLINE_HEADER, "")
    .replace(OMO_NUMBERED_LIST, "")
    .replace(OMO_BULLET_LIST, "")
}
