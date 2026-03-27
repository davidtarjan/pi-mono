import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const dependentCallSchema = Type.Object({
	tool: Type.String({ description: "Tool name to execute." }),
	arguments: Type.Record(Type.String(), Type.Unknown(), {
		description:
			'Arguments object for that tool. Put the target tool parameters inside this nested \'arguments\' object, e.g. { "tool": "read", "arguments": { "path": "file.txt" } }.',
	}),
});

const seqDependentSchema = Type.Object({
	calls: Type.Array(dependentCallSchema, {
		description:
			"Ordered tool calls. Each item must have the shape { tool: string, arguments: object }. Calls execute in order and stop on the first error.",
		minItems: 1,
	}),
});

export type SeqDependentToolInput = Static<typeof seqDependentSchema>;

export interface SeqDependentToolDetails {
	steps: Array<{
		tool: string;
		isError: boolean;
		contentText: string;
	}>;
	stoppedEarly: boolean;
	failedTool?: string;
}

function contentToText(content: Array<{ type: string; text?: string }>): string {
	const text = content
		.filter((block): block is { type: string; text: string } => typeof (block as { text?: string }).text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text || "(no text output)";
}

export function createSeqDependentToolDefinition(): ToolDefinition<typeof seqDependentSchema, SeqDependentToolDetails> {
	return {
		name: "multi_tool_use.seq_dependent",
		label: "Seq Dependent",
		description:
			"Execute dependent tool calls sequentially in one wrapper call. Stops on the first error and returns completed step outputs.",
		promptSnippet:
			'Run dependent tool calls sequentially in one wrapper call. Each calls item must be shaped like { tool: "name", arguments: { ... } }. Stop on the first error.',
		promptGuidelines: [
			"Use multi_tool_use.seq_dependent when later tool calls depend on earlier ones (for example edit/write then test).",
			"Provide calls in execution order. This wrapper stops on the first tool error and does not run later steps.",
			"Each calls entry must be an object with exactly two fields: tool and arguments. Put the target tool parameters inside arguments.",
			'Example: { "calls": [ { "tool": "write", "arguments": { "path": "a.txt", "content": "hello" } }, { "tool": "read", "arguments": { "path": "a.txt" } } ] }',
		],
		parameters: seqDependentSchema,
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			const steps: SeqDependentToolDetails["steps"] = [];
			for (let index = 0; index < params.calls.length; index++) {
				const call = params.calls[index];
				if (call.tool === "multi_tool_use.seq_dependent") {
					const contentText = "Recursive multi_tool_use.seq_dependent calls are not allowed";
					steps.push({ tool: call.tool, isError: true, contentText });
					return {
						content: [{ type: "text", text: contentText }],
						details: { steps, stoppedEarly: true, failedTool: call.tool },
					};
				}
				const executed = await ctx.runTool(call.tool, call.arguments, {
					toolCallId: `${toolCallId}_${index + 1}`,
					signal,
				});
				const contentText = contentToText(executed.result.content as Array<{ type: string; text?: string }>);
				steps.push({ tool: call.tool, isError: executed.isError, contentText });
				if (executed.isError) {
					const lines = steps.map(
						(step, stepIndex) =>
							`${stepIndex + 1}. ${step.tool}${step.isError ? " [error]" : ""}\n${step.contentText}`,
					);
					return {
						content: [
							{
								type: "text",
								text: `Stopped after tool ${index + 1} (${call.tool}) failed.\n\n${lines.join("\n\n")}`,
							},
						],
						details: { steps, stoppedEarly: true, failedTool: call.tool },
					};
				}
			}
			const lines = steps.map((step, stepIndex) => `${stepIndex + 1}. ${step.tool}\n${step.contentText}`);
			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: { steps, stoppedEarly: false },
			};
		},
	};
}

export const seqDependentToolDefinition = createSeqDependentToolDefinition();
export const seqDependentTool = wrapToolDefinition(seqDependentToolDefinition);
