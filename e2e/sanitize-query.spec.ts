import { describe, it, expect } from "vitest"
import { sanitizeSearchQuery } from "../src/index.js"

// ---------------------------------------------------------------------------
// sanitizeSearchQuery - query sanitization for mempalace search.
// ---------------------------------------------------------------------------
// Given the user message, when the search query is extracted, the sanitization
// pipeline should:
//   1. Strip symbols (punctuation / non-word non-space chars) - default ON
//   2. Remove words whose length is <= minWordLength - default ON, threshold 3
// Both options are configurable via plugin-config.json.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  stripSymbols: true,
  removeShortWords: true,
  minWordLength: 3,
}

// ---------------------------------------------------------------------------
// stripSymbols - default ON
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery stripSymbols @search", () => {
  it("given a message with commas and exclamation marks, when sanitizing with stripSymbols=true, then symbols are removed", () => {
    const out = sanitizeSearchQuery("Hello, world!", DEFAULTS)
    expect(out).toBe("Hello world")
  })

  it("given a message with at-sign and question mark, when sanitizing with stripSymbols=true, then symbols are removed", () => {
    const out = sanitizeSearchQuery("What's the @home?", DEFAULTS)
    // After stripSymbols: "Whats the home". After removeShortWords (<=3): "the"(3) dropped.
    expect(out).toBe("Whats home")
  })

  it("given a message with brackets and slashes, when sanitizing with stripSymbols=true, then symbols are removed", () => {
    const out = sanitizeSearchQuery("[CONTEXT] foo /bar", DEFAULTS)
    // After stripSymbols: "CONTEXT foo bar". After removeShortWords (<=3): foo(3) and bar(3) dropped.
    expect(out).toBe("CONTEXT")
  })

  it("given a message with parentheses and dots, when sanitizing with stripSymbols=true, then symbols are removed", () => {
    const out = sanitizeSearchQuery("foo(bar).baz", DEFAULTS)
    expect(out).toBe("foobarbaz")
  })

  it("given a message with a hyphenated compound word, when sanitizing with stripSymbols=true, then the hyphen is removed and words merge", () => {
    const out = sanitizeSearchQuery("Hello-world!", DEFAULTS)
    expect(out).toBe("Helloworld")
  })

  it("given a message with digits and underscores, when sanitizing with stripSymbols=true, then digits are preserved and underscores are treated as word chars", () => {
    const out = sanitizeSearchQuery("task_42 done.", DEFAULTS)
    // underscore stays (word char); period removed; "task_42" (7 chars) kept, "done" (4) kept
    expect(out).toBe("task_42 done")
  })
})

// ---------------------------------------------------------------------------
// stripSymbols - disabled
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery stripSymbols disabled @search", () => {
  it("given a message with commas and exclamation marks, when sanitizing with stripSymbols=false, then symbols are preserved", () => {
    const out = sanitizeSearchQuery("Hello, world!", {
      stripSymbols: false,
      removeShortWords: false,
      minWordLength: 3,
    })
    expect(out).toBe("Hello, world!")
  })

  it("given a message with brackets, when sanitizing with stripSymbols=false, then brackets are preserved", () => {
    const out = sanitizeSearchQuery("[CONTEXT] foo", {
      stripSymbols: false,
      removeShortWords: false,
      minWordLength: 3,
    })
    expect(out).toBe("[CONTEXT] foo")
  })
})

// ---------------------------------------------------------------------------
// removeShortWords - default ON, minWordLength=3
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery removeShortWords @search", () => {
  it("given a message with mixed-length words, when sanitizing with removeShortWords=true and minWordLength=3, then words shorter than 4 chars are dropped", () => {
    const out = sanitizeSearchQuery("I am working on the project", DEFAULTS)
    // words: I(1), am(2), working(7), on(2), the(3), project(7)
    // drop <=3 chars: I, am, on, the dropped
    expect(out).toBe("working project")
  })

  it("given a message where every word is short, when sanitizing with removeShortWords=true, then the result is empty", () => {
    const out = sanitizeSearchQuery("the cat sat on a mat", DEFAULTS)
    expect(out).toBe("")
  })

  it("given a message with 3-character words, when sanitizing with minWordLength=3, then 3-char words are dropped (length <= threshold)", () => {
    // length <= minWordLength means <= 3 chars dropped, > 3 kept
    const out = sanitizeSearchQuery("foo bar baz qux quux", DEFAULTS)
    // foo(3), bar(3), baz(3), qux(3), quux(4)
    // keep only quux
    expect(out).toBe("quux")
  })

  it("given a message with a single long word, when sanitizing with removeShortWords=true, then the word is kept", () => {
    const out = sanitizeSearchQuery("supercalifragilistic", DEFAULTS)
    expect(out).toBe("supercalifragilistic")
  })
})

// ---------------------------------------------------------------------------
// removeShortWords - disabled
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery removeShortWords disabled @search", () => {
  it("given a message with mixed-length words, when sanitizing with removeShortWords=false, then all words are preserved", () => {
    const out = sanitizeSearchQuery("I am working on the project", {
      stripSymbols: false,
      removeShortWords: false,
      minWordLength: 3,
    })
    expect(out).toBe("I am working on the project")
  })
})

// ---------------------------------------------------------------------------
// minWordLength - custom threshold
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery minWordLength custom @search", () => {
  it("given a message, when sanitizing with minWordLength=5, then words with 5 chars or fewer are dropped", () => {
    const out = sanitizeSearchQuery("I am working on the big project today", {
      stripSymbols: false,
      removeShortWords: true,
      minWordLength: 5,
    })
    // I(1), am(2), working(7), on(2), the(3), big(3), project(7), today(5)
    // length <= 5 dropped: I, am, working(?), on, the, big, project, today
    // working(7) and project(7) kept
    expect(out).toBe("working project")
  })

  it("given a message, when sanitizing with minWordLength=10, then only words longer than 10 chars survive", () => {
    const out = sanitizeSearchQuery("internationalization is wonderful", {
      stripSymbols: false,
      removeShortWords: true,
      minWordLength: 10,
    })
    // internationalization(20), is(2), wonderful(9)
    expect(out).toBe("internationalization")
  })

  it("given a message, when sanitizing with minWordLength=1, then only single-char words are dropped", () => {
    const out = sanitizeSearchQuery("I am working on a project", {
      stripSymbols: false,
      removeShortWords: true,
      minWordLength: 1,
    })
    // length <= 1 dropped: I(1) and a(1) dropped, others kept
    expect(out).toBe("am working on project")
  })
})

// ---------------------------------------------------------------------------
// Combined behavior - strip symbols + remove short words together
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery combined behavior @search", () => {
  it("given a message with symbols and short words, when sanitizing with both defaults enabled, then symbols are stripped and short words are dropped", () => {
    const out = sanitizeSearchQuery("Hello, world! How are you?", DEFAULTS)
    // after strip symbols: "Hello world How are you"
    // after remove short words (<=3): "Hello world" (How=3 dropped, are=3 dropped, you=3 dropped)
    expect(out).toBe("Hello world")
  })

  it("given a message with symbols only attached to long words, when sanitizing with both defaults, then symbols are stripped but long words survive", () => {
    const out = sanitizeSearchQuery("[deployment] succeeded! configuration: ok", DEFAULTS)
    // after strip symbols: "deployment succeeded configuration ok"
    // after remove short words (<=3): "deployment succeeded configuration" (ok=2 dropped)
    expect(out).toBe("deployment succeeded configuration")
  })

  it("given both options disabled, when sanitizing, then the message is unchanged except for whitespace collapse", () => {
    const out = sanitizeSearchQuery("Hello, world!", {
      stripSymbols: false,
      removeShortWords: false,
      minWordLength: 3,
    })
    expect(out).toBe("Hello, world!")
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery edge cases @search", () => {
  it("given empty input, when sanitizing, then empty string is returned", () => {
    expect(sanitizeSearchQuery("", DEFAULTS)).toBe("")
  })

  it("given whitespace-only input, when sanitizing, then empty string is returned", () => {
    expect(sanitizeSearchQuery("   \t\n  ", DEFAULTS)).toBe("")
  })

  it("given input where all words are short, when sanitizing with removeShortWords=true, then result has no double spaces", () => {
    const out = sanitizeSearchQuery("a b c d e", DEFAULTS)
    expect(out).toBe("")
    expect(out).not.toMatch(/\s\s/)
  })

  it("given input with leading/trailing whitespace, when sanitizing, then whitespace is trimmed", () => {
    const out = sanitizeSearchQuery("   Hello world   ", DEFAULTS)
    expect(out).toBe("Hello world")
  })

  it("given only-symbols input, when sanitizing with stripSymbols=true, then empty string is returned", () => {
    const out = sanitizeSearchQuery("!!! ??? ...", DEFAULTS)
    expect(out).toBe("")
  })

  it("given input that becomes empty after stripping, when sanitizing, then empty string is returned (not undefined or null)", () => {
    const out = sanitizeSearchQuery(",,,", DEFAULTS)
    expect(out).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Whitespace cleanup after sanitization
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery whitespace cleanup @search", () => {
  it("given words separated by symbols, when sanitizing with stripSymbols=true, then no double spaces remain", () => {
    const out = sanitizeSearchQuery("foo,bar.baz;qux", {
      stripSymbols: true,
      removeShortWords: false,
      minWordLength: 3,
    })
    expect(out).toBe("foobarbazqux")
    expect(out).not.toMatch(/\s/)
  })

  it("given words with mixed whitespace and symbols, when sanitizing with both options, then output has single spaces between surviving words", () => {
    const out = sanitizeSearchQuery("  the  cat  sat  on  mat  ", {
      stripSymbols: false,
      removeShortWords: true,
      minWordLength: 3,
    })
    // words >=4 chars: none
    expect(out).toBe("")
  })

  it("given words with tabs and newlines, when sanitizing, then whitespace is normalized", () => {
    const out = sanitizeSearchQuery("foo\tbar\nbaz", {
      stripSymbols: false,
      removeShortWords: false,
      minWordLength: 3,
    })
    expect(out).toBe("foo bar baz")
  })
})
