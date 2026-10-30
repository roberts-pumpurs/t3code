import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

type ExtractElicitationForm = NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]>;
type ElicitationContent = Record<string, string | boolean | Array<string>>;

const Choice = Schema.Struct({
  const: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
const isForm = Schema.is(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);
const isSelect = Schema.is(
  Schema.Struct({ type: Schema.Literal("string"), enum: Schema.Array(Schema.String) }),
);
const isConfirm = Schema.is(Schema.Struct({ type: Schema.Literal("boolean") }));
const isText = Schema.is(
  Schema.Struct({ type: Schema.Literal("string"), default: Schema.optional(Schema.String) }),
);
const isAskSingle = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: Schema.String,
    description: Schema.optional(Schema.String),
    oneOf: Schema.Array(Choice),
  }),
);
const isAskMulti = Schema.is(
  Schema.Struct({
    type: Schema.Literal("array"),
    title: Schema.String,
    description: Schema.optional(Schema.String),
    items: Schema.Struct({ anyOf: Schema.Array(Choice) }),
  }),
);

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";
const nonEmpty = (value: string | undefined, fallback: string) => value?.trim() || fallback;

function answerStrings(value: unknown): ReadonlyArray<string> {
  if (Predicate.isString(value)) return value.trim() ? [value] : [];
  return Array.isArray(value) ? value.filter((entry) => Predicate.isString(entry)) : [];
}

/**
 * omp sends every extension dialog (tool approvals for edits, select, confirm, input) as a
 * one-field form keyed `value`. The message's first line is the dialog title.
 */
function extractDialog(message: string, field: unknown): ReturnType<ExtractElicitationForm> {
  const question = {
    id: "value",
    header: nonEmpty(firstLine(message), "Oh My Pi"),
    question: nonEmpty(message, "Oh My Pi needs input."),
  };
  if (isSelect(field)) {
    const labels = field.enum.filter((label) => label.trim());
    if (labels.length === 0) return undefined;
    return {
      questions: [
        {
          ...question,
          options: labels.map((label) => ({ label, description: label })),
          allowCustomAnswer: false,
        },
      ],
      respond: (answers) => {
        const answer = answerStrings(answers.value)[0];
        return answer !== undefined && labels.includes(answer)
          ? { action: "accept", content: { value: answer } }
          : { action: "cancel" };
      },
    };
  }
  if (isConfirm(field)) {
    return {
      questions: [
        {
          ...question,
          options: [
            { label: "Yes", description: "Confirm", value: "true" },
            { label: "No", description: "Decline", value: "false" },
          ],
          allowCustomAnswer: false,
        },
      ],
      // omp reads only a boolean; the generic form mapping would send the string "true".
      respond: (answers) => {
        const answer = answerStrings(answers.value)[0];
        return answer === "true" || answer === "false"
          ? { action: "accept", content: { value: answer === "true" } }
          : { action: "cancel" };
      },
    };
  }
  if (isText(field)) {
    return {
      questions: [
        { ...question, options: [], ...(field.default ? { initialAnswer: field.default } : {}) },
      ],
      respond: (answers) => {
        const answer = answerStrings(answers.value)[0];
        return answer === undefined
          ? { action: "cancel" }
          : { action: "accept", content: { value: answer } };
      },
    };
  }
  return undefined;
}

interface AskQuestion extends OrchestrationV2UserInputQuestion {
  readonly key: string;
}

/**
 * omp's `ask` tool sends `q<N>` (the choices) plus `q<N>__other` (its "Other" text box) per
 * question. T3 already offers a custom answer, so fold the pair into one question.
 */
function extractAsk(
  message: string,
  properties: Readonly<Record<string, unknown>>,
): ReturnType<ExtractElicitationForm> {
  const keys = Object.keys(properties);
  const indexes = new Set<number>();
  for (const key of keys) {
    const match = /^q(\d+)(__other)?$/.exec(key);
    if (match === null) return undefined;
    indexes.add(Number(match[1]));
  }
  const ordered = [...indexes].toSorted((left, right) => left - right);
  if (ordered.length === 0 || ordered.some((index, position) => index !== position)) {
    return undefined;
  }
  const questions: Array<AskQuestion> = [];
  for (const index of ordered) {
    const key = `q${index}`;
    if (!isText(properties[`${key}__other`])) return undefined;
    const field = properties[key];
    const fallbackQuestion = ordered.length === 1 ? message : `Question ${index + 1}`;
    if (field === undefined) {
      questions.push({
        key,
        id: key,
        header: `Question ${index + 1}`,
        question: nonEmpty(fallbackQuestion, `Question ${index + 1}`),
        options: [],
      });
      continue;
    }
    const multi = isAskMulti(field);
    if (!multi && !isAskSingle(field)) return undefined;
    const choices = multi ? field.items.anyOf : field.oneOf;
    questions.push({
      key,
      id: key,
      header: nonEmpty(field.description, `Question ${index + 1}`),
      question: nonEmpty(field.title, fallbackQuestion),
      options: choices.map((choice) => {
        const label = nonEmpty(choice.title, choice.const);
        return { label, description: nonEmpty(choice.description, label), value: choice.const };
      }),
      ...(multi ? { multiSelect: true } : {}),
    });
  }
  return {
    questions: questions.map(({ key: _key, ...question }) => question),
    respond: (answers: ProviderUserInputAnswers) => {
      const content: ElicitationContent = {};
      for (const question of questions) {
        const values = question.options.map((option) => option.value);
        const picked = answerStrings(answers[question.key]);
        const chosen = picked.filter((answer) => values.includes(answer));
        const custom = picked.filter((answer) => !values.includes(answer)).join("\n");
        if (question.multiSelect === true) {
          content[question.key] = chosen;
        } else if (chosen[0] !== undefined) {
          content[question.key] = chosen[0];
        }
        if (custom) content[`${question.key}__other`] = custom;
      }
      return { action: "accept", content };
    },
  };
}

export const extractOmpElicitationForm: ExtractElicitationForm = (request) => {
  if (request.mode !== "form" || !isForm(request.requestedSchema)) return undefined;
  const { properties } = request.requestedSchema;
  const keys = Object.keys(properties);
  if (keys.length === 1 && keys[0] === "value") {
    return extractDialog(request.message, properties.value);
  }
  return extractAsk(request.message, properties);
};
