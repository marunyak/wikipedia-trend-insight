#!/usr/bin/env node
/**
 * model-eval.mjs — checks whether a cheap, tool-using model can correctly
 * DRIVE this skill from SKILL.md alone, without a human in the loop.
 *
 * This is the validation the task brief asks for ("Перевір повний сценарій
 * на такій моделі ... Claude Haiku 4.5 ... або недорогі/безкоштовні моделі
 * OpenRouter") and that could not be run inside the sandboxed environment
 * this skill was developed in (no outbound network access to any API,
 * OpenRouter included — confirmed with a zero-cost, keyless request before
 * ever touching a real API key).
 *
 * What it actually checks, per example query from the task brief:
 *  1. Does the model produce a well-formed tool call matching
 *     analyzeTopic.js's real CLI flags (right topic, right languages,
 *     sensible years, an --output path) — i.e. did it read SKILL.md's
 *     "Core workflow" correctly instead of hallucinating flags?
 *  2. Given a REALISTIC canned JSON result (shaped exactly like
 *     analyzeTopic.js's real stdout — see FAKE_RESULTS below), does the
 *     model's final answer correctly reflect reliabilityFlags / robust vs.
 *     raw growth / direction === "flat" meaning "no real trend" — i.e. did
 *     it follow SKILL.md's "Reading the numbers correctly" section, or did
 *     it just quote the biggest percentage it saw?
 *
 * This does NOT execute the real CLI or hit the real Wikimedia API — it
 * tests the model's *reasoning against SKILL.md*, which is the part a
 * cheap model is actually at risk of getting wrong (constructing the tool
 * call, and correctly interpreting caveats). Actually running the compiled
 * CLI was already verified deterministically by tests/offline.test.ts and
 * doesn't depend on which model is driving it.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node tests/model-eval.mjs
 *   OPENROUTER_API_KEY=sk-or-... MODEL=anthropic/claude-haiku-4.5 node tests/model-eval.mjs
 *
 * Cost: a handful of short chat completions on a Haiku-class model —
 * a fraction of a cent total. Nothing here loops or retries on its own.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = readFileSync(join(HERE, "..", "SKILL.md"), "utf-8");

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("Set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys) and re-run.");
  process.exit(1);
}
const MODEL = process.env.MODEL || "anthropic/claude-haiku-4.5";

// The exact tool schema a real agent runtime would expose for this skill's
// CLI — mirrors analyzeTopic.ts's actual flags one-to-one, nothing invented
// for the sake of the test.
const TOOL = {
  type: "function",
  function: {
    name: "run_analyze_topic",
    description:
      "Analyze Wikipedia pageview trends for a topic across one or more language editions and produce a PDF report. Mirrors: node dist/analyzeTopic.js",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Human-readable topic, e.g. 'intermittent fasting'" },
        languages: { type: "array", items: { type: "string" }, description: "ISO language codes, e.g. ['pl','cs']" },
        years: { type: "number", description: "Lookback window in years (default 2)" },
        output: { type: "string", description: "Output PDF path" },
        userQuestion: { type: "string", description: "Original user question, echoed on the report" },
        access: { type: "string", enum: ["all-access", "desktop", "mobile-app", "mobile-web"] },
        agent: { type: "string", enum: ["user", "all-agents", "spider", "automated"] },
        anchorLanguage: {
          type: "string",
          description:
            "Only set this if the topic phrase is in a language other than English AND other than the first entry in languages (rare) — e.g. a French topic phrase being compared across German/Spanish editions.",
        },
      },
      required: ["topic", "languages"],
    },
  },
};

// The 3 example queries from the task brief, verbatim.
const QUERIES = [
  "Порівняй зростання інтересу до інтервального голодування в польськомовній та чеськомовній Wikipedia за останні два роки.",
  "Ми думаємо додати курс з астрономії до освітнього застосунку. Чи зростає інтерес до цієї теми в україномовній Wikipedia, і наскільки цьому зростанню можна довіряти?",
  "Ми створюємо застосунок для вивчення мов. Порівняй інтерес до вивчення англійської у вибраних нами мовних розділах (польська, чеська, словацька) та підготуй короткий звіт: які аудиторії варто дослідити наступними й чому?",
];

// Canned results shaped EXACTLY like analyzeTopic.js's real stdout, used to
// test step 2 (interpreting results), not step 1 (calling the tool).
// "sk" is deliberately flat/insignificant and "pl" deliberately low-volume,
// to check whether the model parrots a big raw number or correctly says
// "no real trend" / "too little data to trust."
const FAKE_RESULT_FOR_QUERY_3 = {
  topic: "learning English",
  dateRange: "2023-01 to 2024-12",
  outputPdf: "/tmp/report.pdf",
  assumptions: { access: "all-access", agent: "user" },
  rankedByRobustGrowth: [
    {
      label: "cs · Angličtina",
      direction: "growing",
      robustPctPerMonth: 4.8,
      yoyChangePct: 78,
      meanMonthlyViews: 2100,
      nMonths: 24,
      reliabilityFlags: [],
    },
    {
      label: "sk · Angličtina",
      direction: "flat",
      robustPctPerMonth: 0.3,
      yoyChangePct: 4,
      meanMonthlyViews: 640,
      nMonths: 24,
      reliabilityFlags: ["trend not statistically significant (p=0.41) — month-to-month noise could plausibly explain the apparent direction"],
    },
    {
      label: "pl · Nauka języka angielskiego",
      direction: "insufficient_data",
      robustPctPerMonth: 0,
      yoyChangePct: null,
      meanMonthlyViews: 22,
      nMonths: 4,
      reliabilityFlags: ["short_history: fewer than 6 months of data — no trend claim is reliable"],
    },
  ],
  resolutionNotes: [],
};

async function chat(messages, tools) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: tools ? "auto" : undefined, max_tokens: 1200 }),
  });
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function printToolCall(msg) {
  const calls = msg.tool_calls ?? [];
  if (calls.length === 0) {
    console.log("  ⚠ No tool call made. Model said:", (msg.content || "").slice(0, 300));
    return;
  }
  for (const c of calls) {
    console.log(`  ✓ Called ${c.function.name} with:`, c.function.arguments);
  }
}

async function main() {
  console.log(`Model under test: ${MODEL}\n`);

  console.log("=== STEP 1: Does the model form correct tool calls from SKILL.md alone? ===\n");
  for (const [i, q] of QUERIES.entries()) {
    console.log(`--- Query ${i + 1}: ${q.slice(0, 70)}...`);
    const result = await chat(
      [
        { role: "system", content: SKILL_MD },
        { role: "user", content: q },
      ],
      [TOOL],
    );
    printToolCall(result.choices[0].message);
    console.log();
  }

  console.log("=== STEP 2: Does the model correctly interpret caveats/reliability in a real result? ===\n");
  const q3 = QUERIES[2];
  const result2 = await chat([
    { role: "system", content: SKILL_MD },
    { role: "user", content: q3 },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "run_analyze_topic",
            arguments: JSON.stringify({ topic: "learning English", languages: ["cs", "sk", "pl"], years: 2, output: "/tmp/report.pdf" }),
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: JSON.stringify(FAKE_RESULT_FOR_QUERY_3) },
  ]);
  const finalAnswer = result2.choices[0].message.content;
  console.log(finalAnswer);
  console.log();

  console.log("=== Manual check ===");
  console.log("Good signs: mentions 'sk' is flat/not significant (not just 'growing');");
  console.log("mentions 'pl' has too little data to trust (not a %, or an explicit caveat);");
  console.log("leads with 'cs' as the one real, trustworthy growth signal.");
  console.log("Bad signs: reports all three as straightforwardly 'growing'; quotes pl's");
  console.log("robustPctPerMonth (0%, meaningless here) as if it were informative; ignores reliabilityFlags entirely.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
