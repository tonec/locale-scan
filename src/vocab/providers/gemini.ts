import { ApiError, GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { DEFINITION_JSON_SCHEMA, DefinitionSchema, type DefinitionProvider } from '../define.js';

/** The parts of the SDK client and response this provider uses (lets tests inject a fake). */
export interface GeminiClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GeminiResponse> };
}
export interface GeminiResponse {
  text?: string;
  candidates?: { finishReason?: string }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
}

/** Gemini via @google/genai: JSON-mode output constrained by the definition schema, then validated with zod. */
export function geminiProvider(model: string, client?: GeminiClient): DefinitionProvider {
  const ai = client ?? defaultClient();
  return {
    name: 'gemini',
    model,
    async define(system, prompt) {
      let response: GeminiResponse;
      try {
        response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            responseMimeType: 'application/json',
            responseJsonSchema: DEFINITION_JSON_SCHEMA,
          },
        });
      } catch (err) {
        if (err instanceof ApiError) throw new Error(`Gemini API error ${err.status}: ${err.message}`);
        throw err;
      }

      const blocked = response.promptFeedback?.blockReason;
      if (blocked) throw new Error(`Gemini blocked the prompt (${blocked}${fmt(response.promptFeedback?.blockReasonMessage)})`);
      const finish = response.candidates?.[0]?.finishReason;
      if (finish && finish !== 'STOP') throw new Error(`Gemini stopped early (finishReason: ${finish})`);
      if (!response.text) throw new Error('Gemini returned no text');

      let json: unknown;
      try {
        json = JSON.parse(response.text);
      } catch {
        throw new Error(`Gemini returned invalid JSON: ${response.text.slice(0, 200)}`);
      }
      const parsed = DefinitionSchema.safeParse(json);
      if (!parsed.success) throw new Error(`Gemini output did not match the schema: ${parsed.error.message}`);
      return { ...parsed.data, model };
    },
  };
}

function defaultClient(): GeminiClient {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error('Set GEMINI_API_KEY (or GOOGLE_API_KEY) to use --provider gemini');
  }
  return new GoogleGenAI({});
}

const fmt = (msg?: string) => (msg ? `: ${msg}` : '');
