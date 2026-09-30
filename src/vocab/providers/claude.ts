import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { DefinitionSchema, type DefinitionProvider } from '../define.js';

/** Claude via the Anthropic SDK: structured output, with server-side fallback on refusals. */
export function claudeProvider(model: string, client = new Anthropic()): DefinitionProvider {
  return {
    name: 'claude',
    model,
    async define(system, prompt) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaZodOutputFormat(DefinitionSchema) },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') {
        throw new Error(`Claude declined to define this term (${response.stop_details?.category ?? 'no category'})`);
      }
      if (!response.parsed_output) {
        throw new Error(`No structured output (stop_reason: ${response.stop_reason})`);
      }
      return { ...response.parsed_output, model: response.model };
    },
  };
}
